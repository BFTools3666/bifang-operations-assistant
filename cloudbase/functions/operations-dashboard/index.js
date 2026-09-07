"use strict";

const { createHandler } = require("./src/handler");

const main = createHandler();

exports.main = main;
exports.handler = main;
exports.createHandler = createHandler;
