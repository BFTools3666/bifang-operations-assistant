"use strict";

const { createHandler } = require("./src/handler");
const {
  createCloudBaseRepository,
  parseApplicationResources,
} = require("./src/repository");

const main = createHandler();

exports.main = main;
exports.handler = main;
exports.createHandler = createHandler;
exports.createCloudBaseRepository = createCloudBaseRepository;
exports.parseApplicationResources = parseApplicationResources;
