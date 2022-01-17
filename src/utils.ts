import * as crypto from "crypto";
import * as core from "@actions/core";

const RETRIES = 5;
const WAIT_BETWEEN_TRIES = 1000;

export const generateJobName = (action: string, database_name: string) => {
  const fullJobName = `gha-review-service-${action}-${database_name}`;
  // Job name can be only 52, as there needs to be space for appended hashes when pods created.
  if (fullJobName.length < 53) {
    return fullJobName;
  } else {
    const jobHash = crypto
      .createHash("sha256")
      .update(fullJobName)
      .digest("hex")
      .substring(0, 8);
    return `${fullJobName.substring(0, 40)}-${jobHash}`;
  }
};

function waitFor(milliSeconds: number) {
  return new Promise<void>((resolve, _reject) => {
    setTimeout(() => {
      resolve();
    }, milliSeconds);
  });
}

export const makeRetryedCall = async (
  promise: Promise<any>,
  retryNumber = 0
): Promise<any> => {
  try {
    const response = await promise;
    return response;
  } catch (e) {
    if (retryNumber >= RETRIES) {
      return Promise.reject(e);
    }
    await waitFor(WAIT_BETWEEN_TRIES);
    return makeRetryedCall(promise, retryNumber + 1);
  }
};
