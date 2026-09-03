"use strict";

const { createHandler } = require("./src/handler");
const { createCloudBaseWriter } = require("./src/writer");

// The SDK is loaded lazily by the writer, so importing this module in local tests
// never needs CloudBase credentials or a live CloudBase environment.
const main = createHandler();

exports.main = main;
exports.handler = main;
exports.createHandler = createHandler;
exports.createCloudBaseWriter = createCloudBaseWriter;
