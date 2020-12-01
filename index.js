// Copyright 2020 Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

const core = require("@actions/core");
const { runBuild } = require("./code-build");
const assert = require("assert");

/* istanbul ignore next */
if (require.main === module) {
  run();
}

module.exports = run;

async function run() {
  console.log("*****STARTING CODEBUILD*****");
  try {
    const { id, buildStatus } = await runBuild();
    core.setOutput("aws-build-id", id);

    const status = new Set(["SUCCEEDED", "IN_PROGRESS"]);
    // Signal the outcome
    assert(
      status.has(buildStatus),
      `Build status: ${buildStatus}`
    );
  } catch (error) {
    console.log(error);
    core.setFailed(error.message);
  } finally {
    console.log("*****CODEBUILD COMPLETE*****");
  }
}
