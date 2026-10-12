import assert from "node:assert/strict";
import { test } from "node:test";
import { AxiosError } from "axios";
import { retryDelayMs, handleMeshyError } from "../dist/services/error-handler.js";
import { getTaskWithAutoInference } from "../dist/services/meshy-client.js";

// Offline checks for the retry policy, task lookup, error messages and polling.

function httpError(method, status, message, headers = {}) {
  const config = { method, headers: {} };
  return new AxiosError(message, undefined, config, {}, { status, data: { message }, headers, config, statusText: "" });
}

function networkError(method, code) {
  return new AxiosError("network", code, { method, headers: {} });
}

test("a create is never resent after a timeout, network error or 5xx", () => {
  for (const error of [
    networkError("post", "ECONNABORTED"),
    networkError("post", "ECONNRESET"),
    httpError("post", 500, "boom"),
    httpError("post", 503, "boom"),
  ]) {
    assert.equal(retryDelayMs("post", error, 0), undefined);
  }
});

test("a create retries only the request limiter's 429, honoring Retry-After", () => {
  assert.equal(retryDelayMs("post", httpError("post", 429, "Rate limit exceeded"), 0), 2000);
  assert.equal(retryDelayMs("post", httpError("post", 429, "Rate limit exceeded", { "retry-after": "3" }), 0), 3000);
  for (const message of [
    "NoMorePendingTasks: Upgrade your plan to queue up more tasks.",
    "NoMoreConcurrentTasks: You credit is insufficient to queue up more tasks.",
    "Free rig quota exhausted",
  ]) {
    assert.equal(retryDelayMs("post", httpError("post", 429, message), 0), undefined, message);
  }
});

test("reads and deletes retry transient failures, then give up", () => {
  assert.equal(retryDelayMs("get", networkError("get", "ECONNABORTED"), 0), 2000);
  assert.equal(retryDelayMs("get", httpError("get", 502, "bad gateway"), 1), 4000);
  assert.equal(retryDelayMs("delete", httpError("delete", 429, "Rate limit exceeded", { "retry-after": "1" }), 2), 1000);
  assert.equal(retryDelayMs("get", httpError("get", 429, "x", { "retry-after": "120" }), 0), undefined);
  assert.equal(retryDelayMs("get", httpError("get", 503, "x"), 3), undefined);
  assert.equal(retryDelayMs("get", httpError("get", 404, "Task not found"), 0), undefined);
});

test("ambiguous create failures tell the agent to check before resending", () => {
  assert.match(handleMeshyError(networkError("post", "ECONNABORTED")), /may still have created/);
  assert.match(handleMeshyError(httpError("post", 502, "x")), /meshy_list_tasks/);
  assert.doesNotMatch(handleMeshyError(networkError("post", "ENOTFOUND")), /may still have created/);
  assert.doesNotMatch(handleMeshyError(networkError("get", "ECONNABORTED")), /may still have created/);
  assert.match(handleMeshyError(httpError("post", 429, "NoMorePendingTasks: Upgrade your plan")), /queue is full.*NoMorePendingTasks/);
});

function fakeClient(routes) {
  const calls = [];
  return {
    calls,
    async get(path) {
      calls.push(path);
      const task = routes[path];
      if (!task) throw httpError("get", 404, "Task not found");
      return task;
    },
  };
}

test("a task found on a route that answers for every type is re-read from its own route", async () => {
  const rig = { id: "t", type: "rig", status: "SUCCEEDED", result: { rigged_character_glb_url: "u" } };
  const client = fakeClient({
    "/openapi/v2/text-to-3d/t": { id: "t", type: "rig", status: "SUCCEEDED" },
    "/openapi/v1/image-to-3d/t": { id: "t", type: "rig", status: "SUCCEEDED" },
    "/openapi/v1/rigging/t": rig,
  });
  // Omitted type: the first probe is image-to-3d, then the task's own route.
  const found = await getTaskWithAutoInference(client, "t");
  assert.equal(found.taskType, "rigging");
  assert.equal(found.endpoint, "/openapi/v1/rigging");
  assert.deepEqual(found.task, rig);
  assert.deepEqual(client.calls, ["/openapi/v1/image-to-3d/t", "/openapi/v1/rigging/t"]);
  // A wrong type that still answers (text-to-3d) is corrected the same way.
  const wrong = await getTaskWithAutoInference(client, "t", "text-to-3d");
  assert.equal(wrong.taskType, "rigging");
  assert.deepEqual(wrong.task, rig);
});

test("a task only its own route serves is still found, and real errors are not swallowed", async () => {
  const build = { id: "c", type: "creative-lab-lamp-build", status: "SUCCEEDED" };
  const client = fakeClient({ "/openapi/creative-lab/lamp/v1/build/c": build });
  const found = await getTaskWithAutoInference(client, "c");
  assert.equal(found.taskType, "creative-lab-lamp-build");
  assert.equal(client.calls.at(-1), "/openapi/creative-lab/lamp/v1/build/c");
  assert.equal(client.calls.at(-2) === "/openapi/v2/text-to-3d/c", false, "text-to-3d is probed last");

  await assert.rejects(getTaskWithAutoInference(fakeClient({}), "missing"), /not found on any endpoint/);
  const failing = { async get() { throw httpError("get", 503, "down"); } };
  await assert.rejects(getTaskWithAutoInference(failing, "x"), (e) => e.response?.status === 503);
});
