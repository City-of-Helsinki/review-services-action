import * as core from "@actions/core";
import logger from "not-a-log";
import {
  BatchV1Api,
  CoreV1Api,
  CoreV1EventList,
  KubeConfig,
  V1Job,
  V1JobStatus,
  V1PodList,
  V1Secret,
} from "@kubernetes/client-node";
import { makeRetryedCall } from "./utils";

interface Events {
  Reason?: string;
  EventTime?: Date;
  Message?: string;
}

export class Kubernetes {
  k8sBatchV1Api: BatchV1Api;
  k8sCoreApi: CoreV1Api;

  constructor(kubeconfig: string) {
    const kc = new KubeConfig();
    kc.loadFromString(kubeconfig);
    this.k8sBatchV1Api = kc.makeApiClient(BatchV1Api);
    this.k8sCoreApi = kc.makeApiClient(CoreV1Api);
  }

  async namespaceExist(namespaceName: string): Promise<boolean> {
    try {
      await this.k8sCoreApi.readNamespace(namespaceName);
      return true;
    } catch (e) {
      return false;
    }
  }

  async createNamespace(namespaceName: string): Promise<void> {
    await makeRetryedCall(
      this.k8sCoreApi.createNamespace({
        apiVersion: "v1",
        kind: "Namespace",
        metadata: {
          name: namespaceName,
          labels: {
            environment: "review",
            // Needed for synchronizing the secret to download images
            app: "kubed",
          },
        },
      })
    );
  }

  async secretExists(namespaceName: string, jobName: string): Promise<boolean> {
    try {
      await this.k8sCoreApi.readNamespacedSecret(jobName, namespaceName);
      return true;
    } catch (e) {
      return false;
    }
  }

  async createSecret(
    namespaceName: string,
    jobName: string,
    stringData: { [key: string]: string }
  ): Promise<string> {
    const secretBody: V1Secret = {
      apiVersion: "v1",
      kind: "Secret",
      metadata: {
        name: jobName,
        labels: {
          "job-name": jobName,
        },
      },
      stringData,
    };
    if (await this.secretExists(namespaceName, jobName)) {
      await makeRetryedCall(
        this.k8sCoreApi.replaceNamespacedSecret(
          jobName,
          namespaceName,
          secretBody
        )
      );
      return "updated";
    } else {
      await makeRetryedCall(
        this.k8sCoreApi.createNamespacedSecret(namespaceName, secretBody)
      );
      return "created";
    }
  }

  async jobExists(namespaceName: string, jobName: string): Promise<boolean> {
    try {
      await this.k8sBatchV1Api.readNamespacedJob(jobName, namespaceName);
      return true;
    } catch (e) {
      return false;
    }
  }

  async createJob(namespaceName: string, jobName: string, command: string) {
    const job: V1Job = {
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
    };
    if (await this.jobExists(namespaceName, jobName)) {
      await this.k8sBatchV1Api.deleteNamespacedJob(jobName, namespaceName);
    }
    await makeRetryedCall(
      this.k8sBatchV1Api.createNamespacedJob(namespaceName, job)
    );
  }

  async jobSucceeded(namespaceName: string, jobName: string): Promise<boolean> {
    let status = new V1JobStatus();
    const startTime = Date.now();
    let duration = 0;
    while (
      (status.failed || 0) + (status.succeeded || 0) == 0 &&
      duration < 300000 // Wait execution to complete in 5 minutes
    ) {
      await new Promise((r) => setTimeout(r, 10000));
      const result = await makeRetryedCall(
        this.k8sBatchV1Api.readNamespacedJobStatus(jobName, namespaceName)
      );
      status = result.body.status || new V1JobStatus();
      duration = Date.now() - startTime;
    }
    return (status.succeeded || 0) > 0;
  }

  async executeJob(namespaceName: string, jobName: string) {
    if (!(await this.jobSucceeded(namespaceName, jobName))) {
      const response: V1PodList = (
        await makeRetryedCall(
          this.k8sCoreApi.listNamespacedPod(
            namespaceName,
            undefined,
            undefined,
            undefined,
            undefined,
            `job-name=${jobName}`
          )
        )
      ).body;
      if (response.items.length > 0) {
        // Sort list descending order so top one is the latest
        // Use default 0 if times are missing (that shouldn't be the case)
        response.items.sort(
          (a, b) =>
            (b.status?.startTime?.valueOf() ?? 0) -
            (a.status?.startTime?.valueOf() ?? 0)
        );
        const podName = response.items[0].metadata?.name ?? "";
        const podUID = response.items[0].metadata?.uid ?? "";
        const podEvents: CoreV1EventList = (
          await makeRetryedCall(
            this.k8sCoreApi.listNamespacedEvent(
              namespaceName,
              undefined,
              undefined,
              undefined,
              `involvedObject.name=${podName},involvedObject.uid=${podUID}`
            )
          )
        ).body;

        core.info(`\nPod events from ${podName} (${podUID}):\n`);
        const events: Events[] = [];
        podEvents.items.forEach((it) => {
          events.push({
            EventTime: it.firstTimestamp,
            Message: it.message,
            Reason: it.reason,
          });
        });

        core.info(logger.table(events));
        const logResponse = await this.k8sCoreApi.readNamespacedPodLog(
          podName,
          namespaceName,
          "psql",
          false
        );
        core.info("\nPod Logs:\n");
        core.info(logResponse.body);
      }
      core.setFailed(`Job ${jobName} failed`);
    } else {
      core.info(`Job ${jobName} succeeded`);
    }
  }
}
