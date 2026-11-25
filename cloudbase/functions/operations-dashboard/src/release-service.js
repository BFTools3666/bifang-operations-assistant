"use strict";
const { createHmac } = require("node:crypto");
const { createDefaultCloudBaseApp } = require("./reader");
function releaseToken(accessHash, envId) {
  if (!/^[a-f0-9]{64}$/i.test(accessHash || "") || !envId)
    throw new Error("invalid_release_binding");
  return createHmac("sha256", Buffer.from(accessHash, "hex"))
    .update("dashboard-version-service/v1/" + envId)
    .digest("hex");
}
async function invokeRelease(data, runtimeContext) {
  const app = createDefaultCloudBaseApp({ runtimeContext });
  const response = await app.callFunction({
    name: "application-version-api",
    data,
  });
  return response.result;
}
module.exports = { releaseToken, invokeRelease };
