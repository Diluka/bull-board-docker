#!/bin/sh
set -eu

until redis-cli -h redis ping >/dev/null 2>&1; do
  sleep 1
done

redis-cli -h redis ZADD pietra:pipeline:runs 1000 pipeline-test-run >/dev/null
redis-cli -h redis HSET pietra:pipeline:run:pipeline-test-run \
  id pipeline-test-run \
  name social-analysis-report \
  pipelineName social-analysis-report \
  status RUNNING \
  pendingNodes 1 \
  failedNodes 0 \
  createdAt 1784500000000 \
  updatedAt 1784503600000 >/dev/null

redis-cli -h redis ZADD pietra:pipeline:run:pipeline-test-run:nodes \
  1001 report-node \
  1002 trend-node \
  1003 crawl-node >/dev/null

redis-cli -h redis HSET pietra:pipeline:run:pipeline-test-run:node:report-node \
  id report-node \
  runId pipeline-test-run \
  pipelineName social-analysis-report \
  invocationId report-invocation \
  scopeId report-scope \
  name report-work \
  stepName report-work \
  status COMPLETED \
  parentNodeIds '[]' \
  queueName pietra-pipeline--social-analysis-report--report-work \
  jobId report-node \
  attempt 1 \
  maxAttempts 1 \
  progress '{}' >/dev/null

redis-cli -h redis HSET pietra:pipeline:run:pipeline-test-run:node:trend-node \
  id trend-node \
  runId pipeline-test-run \
  pipelineName social-analysis-trend \
  invocationId trend-invocation \
  scopeId trend-scope \
  name generate-trend \
  stepName generate-trend \
  status COMPLETED \
  parentNodeIds '["report-node"]' \
  queueName pietra-pipeline--social-analysis-trend--generate-trend \
  jobId trend-node \
  attempt 1 \
  maxAttempts 3 \
  progress '{"records":12}' >/dev/null

redis-cli -h redis HSET pietra:pipeline:run:pipeline-test-run:node:crawl-node \
  id crawl-node \
  runId pipeline-test-run \
  pipelineName social-analysis-crawl \
  invocationId crawl-invocation \
  scopeId crawl-scope \
  name crawl-source \
  stepName crawl-source \
  status RUNNING \
  parentNodeIds '["report-node"]' \
  queueName pietra-pipeline--social-analysis-crawl--crawl-source \
  jobId crawl-node \
  attempt 1 \
  maxAttempts 3 \
  progress '{"pages":4}' >/dev/null
