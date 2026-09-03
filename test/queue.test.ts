import test from "node:test";
import assert from "node:assert/strict";
import { BoundedQueue } from "../src/queue.ts";

test("applies bounded backpressure and drains in FIFO order", async () => {
  const queue = new BoundedQueue<number>(2);
  assert.equal(queue.tryPush(1), true);
  assert.equal(queue.tryPush(2), true);
  assert.equal(queue.tryPush(3), false);
  assert.equal(await queue.pop(), 1);
  assert.equal(await queue.pop(), 2);
  queue.close();
  assert.equal(await queue.pop(), null);
  assert.equal(queue.tryPush(4), false);
});

test("hands pushed work directly to a waiting consumer", async () => {
  const queue = new BoundedQueue<string>(1);
  const pending = queue.pop();
  assert.equal(queue.tryPush("job"), true);
  assert.equal(await pending, "job");
  queue.close();
});
