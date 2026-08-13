"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { observeSocketErrors } = require("../src/socket.js");

test("observes a connection error without recursively closing the socket", () => {
  let errorListener;
  let closeCalls = 0;
  const readyStates = [];
  const socket = {
    readyState: 0,
    addEventListener(event, listener) {
      assert.equal(event, "error");
      errorListener = listener;
    },
    close() {
      closeCalls += 1;
      errorListener();
    },
  };

  observeSocketErrors(socket, (readyState) => readyStates.push(readyState));
  errorListener();

  assert.deepEqual(readyStates, [0]);
  assert.equal(closeCalls, 0);
});
