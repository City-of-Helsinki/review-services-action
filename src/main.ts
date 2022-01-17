import * as core from "@actions/core";
import { Kubernetes } from "./kubernetes";
import { generateJobName } from "./utils";

const k8s = new Kubernetes(core.getInput("kubeconfig"));

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

const createJob = async () => {
  if (!(await k8s.namespaceExist(action_config.namespace))) {
    await k8s.createNamespace(action_config.namespace);
    core.info(`Namespace ${action_config.namespace} created`);
  } else {
    core.info(`Namespace ${action_config.namespace} exists`);
  }

  const response = await k8s.createSecret(action_config.namespace, jobName, {
    PGHOST: database_config.host,
    PGPORT: String(database_config.port),
    PGUSER: database_config.user,
    PGPASSWORD: database_config.password,
    PGDATABASE: database_config.defaultdb,
  });
  core.info(`Secret ${jobName} ${response}`);
  let command = "";
  switch (action_config.action.toLowerCase()) {
    case CREATE:
      command = `echo "SELECT 'CREATE DATABASE \\"${database_config.name}\\"' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = '${database_config.name}')\\gexec" > command.sql && psql -v ON_ERROR_STOP=1 -f command.sql`;
      break;
    case REMOVE:
      command = `echo "DROP DATABASE \\"${database_config.name}\\"" > command.sql && psql -v ON_ERROR_STOP=1 -f command.sql`;
  }
  await k8s.createJob(action_config.namespace, jobName, command);
  core.info(`Job ${jobName} created`);
};

const execute = async () => {
  try {
    if (![CREATE, REMOVE].includes(action_config.action.toLowerCase())) {
      core.setFailed(
        `Given action ${action_config.action} not supported. Supported ones are ${CREATE} and ${REMOVE}.`
      );
    } else {
      if (
        (await k8s.jobExists(action_config.namespace, jobName)) &&
        (await k8s.jobSucceeded(action_config.namespace, jobName))
      ) {
        core.info(
          `Database successsfully ${action_config.action}d with job ${jobName}, not actions needed.`
        );
      } else {
        await createJob();
        await k8s.executeJob(action_config.namespace, jobName);
      }
    }
  } catch (e) {
    const error = e as Error;
    core.setFailed(error);
  }
};

execute();
