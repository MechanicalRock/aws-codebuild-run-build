// Copyright 2020 Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

const core = require("@actions/core");
const github = require("@actions/github");
const aws = require("aws-sdk");
const assert = require("assert");

module.exports = {
  runBuild,
  build,
  waitForBuildEndTime,
  inputs2Parameters,
  githubInputs,
  buildSdk,
  logName,
};

function runBuild() {
  // get a codeBuild instance from the SDK
  const sdk = buildSdk();

  // Get input options for startBuild
  const inputs = githubInputs();
  const { headers } = inputs;
  const params = inputs2Parameters(inputs);

  return build(sdk, params, headers);
}

async function build(sdk, params, headers) {
  // Start the build
  //const makeRequest = sdk.useCredentials ? sdk.codeBuild.makeRequest : sdk.codeBuild.makeUnauthenticatedRequest;
  const req = sdk.codeBuild.startBuild(params);
  if (!sdk.useCredentials) {
    req.toUnauthenticated();
  }
  req.on("build", (req) => {
    req.httpRequest.headers = { ...req.httpRequest.headers, ...headers };
  });

  const start = await req.promise();

  // Wait for the build to "complete"
  return waitForBuildEndTime(sdk, start.build, null, headers);
}

async function waitForBuildEndTime(sdk, { id, logs }, nextToken, headers) {
  const {
    codeBuild,
    cloudWatchLogs,
    useCredentials,
    wait = 1000 * 30,
    backOff = 1000 * 15,
  } = sdk;

  // Get the CloudWatchLog info
  const startFromHead = true;
  const { cloudWatchLogsArn } = logs;
  const { logGroupName, logStreamName } = logName(cloudWatchLogsArn);

  let errObject = false;

  const batchGetBuilds = codeBuild.batchGetBuilds({ ids: [id] });
  batchGetBuilds.on("build", (req) => {
    req.httpRequest.headers = { ...req.httpRequest.headers, ...headers };
  });

  const getLogEvents = cloudWatchLogs.getLogEvents({
    logGroupName,
    logStreamName,
    startFromHead,
    nextToken,
  });
  getLogEvents.on("build", (req) => {
    req.httpRequest.headers = { ...req.httpRequest.headers, ...headers };
  });

  if (!useCredentials) {
    batchGetBuilds.toUnauthenticated();
    getLogEvents.toUnauthenticated();
  }

  // Check the state
  const [batch, cloudWatch = {}] = await Promise.all([
    batchGetBuilds.promise(),
    // The CloudWatchLog _may_ not be set up, only make the call if we have a logGroupName
    logGroupName && getLogEvents.promise(),
  ]).catch((err) => {
    errObject = err;
    /* Returning [] here so that the assignment above
     * does not throw `TypeError: undefined is not iterable`.
     * The error is handled below,
     * since it might be a rate limit.
     */
    return [];
  });

  if (errObject) {
    //We caught an error in trying to make the AWS api call, and are now checking to see if it was just a rate limiting error
    if (errObject.message && errObject.message.search("Rate exceeded") !== -1) {
      //We were rate-limited, so add `backOff` seconds to the wait time
      let newWait = wait + backOff;

      //Sleep before trying again
      await new Promise((resolve) => setTimeout(resolve, newWait));

      // Try again from the same token position
      return waitForBuildEndTime(
        { ...sdk, wait: newWait },
        { id, logs },
        nextToken,
        headers
      );
    } else {
      //The error returned from the API wasn't about rate limiting, so throw it as an actual error and fail the job
      throw errObject;
    }
  }

  // Pluck off the relevant state
  const [current] = batch.builds;
  const { nextForwardToken, events = [] } = cloudWatch;

  // stdout the CloudWatchLog (everyone likes progress...)
  // CloudWatchLogs have line endings.
  // I trim and then log each line
  // to ensure that the line ending is OS specific.
  events.forEach(({ message }) => console.log(message.trimEnd()));

  // We did it! We can stop looking!
  if (current.endTime && !events.length) return current;

  // More to do: Sleep for a few seconds to avoid rate limiting
  await new Promise((resolve) => setTimeout(resolve, wait));

  // Try again
  return waitForBuildEndTime(sdk, current, nextForwardToken, headers);
}

function githubInputs() {
  const projectName = core.getInput("project-name", { required: true });
  // const { owner, repo } = github.context.repo;
  const { payload } = github.context;
  // The github.context.sha is evaluated on import.
  // This makes it hard to test.
  // So I use the raw ENV.
  // There is a complexity here because for pull request
  // the GITHUB_SHA value is NOT the correct value.
  // See: https://github.com/aws-actions/aws-codebuild-run-build/issues/36
  const sourceVersion =
    process.env[`GITHUB_EVENT_NAME`] === "pull_request"
      ? (((payload || {}).pull_request || {}).head || {}).sha
      : process.env[`GITHUB_SHA`];

  assert(sourceVersion, "No source version could be evaluated.");
  const buildspecOverride = core.getInput("buildspec-override");

  const headers = {
    "x-github-secret": process.env["GITHUB_SECRET"],
    "x-github-sha": process.env["GITHUB_SHA"],
    "x-github-resolved-sha": sourceVersion,
    "x-github-event-name": process.env["GITHUB_EVENT_NAME"],
    "x-github-ref": process.env["GITHUB_REF"],
    "x-github-run-id": process.env["GITHUB_RUN_ID"],
    "x-github-repository": process.env["GITHUB_REPOSITORY"],
  };

  const envPassthrough = core
    .getInput("env-vars-for-codebuild", { required: false })
    .split(",")
    .map((i) => i.trim())
    .filter((i) => i !== "");

  return {
    projectName,
    // owner,
    // repo,
    // sourceVersion,
    buildspecOverride,
    envPassthrough,
    headers,
  };
}

function inputs2Parameters(inputs) {
  const {
    projectName,
    // owner,
    // repo,
    // sourceVersion,
    buildspecOverride,
    envPassthrough = [],
  } = inputs;

  // const sourceTypeOverride = "GITHUB";
  // const sourceLocationOverride = `https://github.com/${owner}/${repo}.git`;

  const sourceTypeOverride = core.getInput("source-type-override");
  const sourceLocationOverride = sourceTypeOverride !== "NO_SOURCE" ?
    core.getInput("source-location-override") : null

  const environmentVariablesOverride = Object.entries(process.env)
    .filter(
      ([key]) => key.startsWith("GITHUB_") || envPassthrough.includes(key)
    )
    .map(([name, value]) => ({ name, value, type: "PLAINTEXT" }));

  // The idempotencyToken is intentionally not set.
  // This way the GitHub events can manage the builds.
  return {
    projectName,
    // sourceVersion,
    sourceTypeOverride,
    sourceLocationOverride,
    buildspecOverride,
    environmentVariablesOverride,
  };
}

function buildSdk() {
  const endpoint = { endpoint: core.getInput("endpoint", { required: false }) };
  const useCredentials = core.getInput("use-aws-credentials", { required: true }).toUpperCase() === 'TRUE';

  const codeBuild = new aws.CodeBuild({
    customUserAgent: "aws-actions/aws-codebuild-run-build",
    ...endpoint,
  });

  const cloudWatchLogs = new aws.CloudWatchLogs({
    customUserAgent: "aws-actions/aws-codebuild-run-build",
    ...endpoint,
  });

  if (useCredentials) {
    assert(
      codeBuild.config.credentials && cloudWatchLogs.config.credentials,
      "No credentials. Try adding @aws-actions/configure-aws-credentials earlier in your job to set up AWS credentials."
    );
  }

  return { codeBuild, cloudWatchLogs, useCredentials };
}

function logName(Arn) {
  const [logGroupName, logStreamName] = Arn.split(":log-group:")
    .pop()
    .split(":log-stream:");
  if (logGroupName === "null" || logStreamName === "null")
    return {
      logGroupName: undefined,
      logStreamName: undefined,
    };
  return { logGroupName, logStreamName };
}
