import * as core from "@actions/core";
import * as crypto from "crypto";
import { V1JobStatus } from "@kubernetes/client-node";
import k8s = require("@kubernetes/client-node");

const generateJobName = (action: string, database_name: string) => {
  const fullJobName = `gha-review-service-${action}-${database_name}`;
  // Job name can be only 52, as there needs to be space for appended hashes when pods created.
  if (fullJobName.length < 53) {
    return fullJobName;
  } else {
    const jobHash = crypto.createHash('sha256').update(fullJobName).digest('hex').substring(0,8);
    return `${fullJobName.substring(0, 40)}-${jobHash}`
  }
}

const kc = new k8s.KubeConfig();

kc.loadFromString(core.getInput("kubeconfig"));

const CREATE = "create";
const REMOVE = "remove";

const action_config = {
  namespace: core.getInput("namespace"),
  action: core.getInput("action"),
};

const database_config = {
  user: core.getInput("db_user"),
  password: core.getInput("db_password"),
  port: core.getInput("db_port"),
  host: core.getInput("db_host"),
  name: core.getInput("database"),
  defaultdb: core.getInput("default_database_name"),
};

const jobName = generateJobName(action_config.action, database_config.name);
const k8sBatchV1Api = kc.makeApiClient(k8s.BatchV1Api);
const k8sCoreApi = kc.makeApiClient(k8s.CoreV1Api);

const createJob = async () => {
  try {
    await k8sCoreApi.readNamespace(action_config.namespace);
    core.info(`Namespace ${action_config.namespace} exists`);
  } catch (e) {
    const error = e as Error;
    core.debug(error.message);
    await k8sCoreApi.createNamespace({
      apiVersion: "v1",
      kind: "Namespace",
      metadata: {
        name: action_config.namespace,
        labels: {
          environment: "review",
          // Needed for synchronizing the secret to download images
          app: "kubed",
        },
      },
    });
    core.info(`Namespace ${action_config.namespace} created`);
  }
  const secrets = await k8sCoreApi.listNamespacedSecret(
    action_config.namespace,
    undefined,
    undefined,
    undefined,
    undefined,
    `job-name=${jobName}`
  );
  if (secrets.body.items.length == 0) {
    await k8sCoreApi.createNamespacedSecret(action_config.namespace, {
      apiVersion: "v1",
      kind: "Secret",
      metadata: {
        name: jobName,
        labels: {
          "job-name": jobName,
        },
      },
      stringData: {
        PGHOST: database_config.host,
        PGPORT: String(database_config.port),
        PGUSER: database_config.user,
        PGPASSWORD: database_config.password,
        PGDATABASE: database_config.defaultdb,
      },
    });
    core.info(`Secret ${jobName} created`);
  }
  let command = "";
  switch (action_config.action.toLowerCase()) {
    case CREATE:
      command = `echo "SELECT 'CREATE DATABASE \\"${database_config.name}\\"' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = '${database_config.name}')\\gexec" > command.sql && psql -v ON_ERROR_STOP=1 -f command.sql`;
      break;
    case REMOVE:
      command = `echo "DROP DATABASE \\"${database_config.name}\\"" > command.sql && psql -v ON_ERROR_STOP=1 -f command.sql`;
  }
  await k8sBatchV1Api.createNamespacedJob(action_config.namespace, {
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: {
      name: jobName,
    },
    spec: {
      backoffLimit: 0,
      completions: 1,
      parallelism: 1,
      template: {
        spec: {
          containers: [
            {
              name: "psql",
              image: "postgres:11-alpine",
              command: ["/bin/sh", "-c"],
              args: [command],
              envFrom: [
                {
                  secretRef: {
                    name: jobName,
                  },
                },
              ],
            },
          ],
          restartPolicy: "Never",
        },
      },
    },
  });
  core.info(`Job ${jobName} created`);
};

const loop = async () => {
  let status = new V1JobStatus();
  while ((status.failed || 0) + (status.succeeded || 0) == 0) {
    await new Promise((r) => setTimeout(r, 1000));
    const result = await k8sBatchV1Api.readNamespacedJobStatus(
      jobName,
      action_config.namespace
    );
    status = result.body.status || new V1JobStatus();
  }
  if (!status || (status && status.failed && status.failed > 0)) {
    const response = await k8sCoreApi.listNamespacedPod(
      action_config.namespace,
      undefined,
      undefined,
      undefined,
      undefined,
      `job-name=${jobName}`
    );
    if (
      response.body.items.length > 0 &&
      response.body.items[0].metadata !== undefined &&
      response.body.items[0].metadata.name !== undefined
    ) {
      const logResponse = await k8sCoreApi.readNamespacedPodLog(
        response.body.items[0].metadata.name,
        action_config.namespace,
        "psql",
        false
      );
      core.info(logResponse.body);
    }
    core.setFailed(`Job ${jobName} failed`);
  } else {
    core.info(`Job ${jobName} succeeded`);
  }
};

const getJobPod = async () => {
  const response = await k8sCoreApi.listNamespacedPod(
    action_config.namespace,
    undefined,
    undefined,
    undefined,
    undefined,
    `job-name=${jobName}`
  );
  return response.body.items;
};

const execute = async () => {
  try {
    if (![CREATE, REMOVE].includes(action_config.action.toLowerCase())) {
      core.setFailed(
        `Given action ${action_config.action} not supported. Supported ones are ${CREATE} and ${REMOVE}.`
      );
    } else {
      const pods = await getJobPod();
      if (pods.length == 0) {
        await createJob();
      }
      loop();
    }
  } catch (e) {
    const error = e as Error;
    core.setFailed(error);
  }
};

execute();
