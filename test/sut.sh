#!/bin/sh
set -eu

base_url='http://nginx/app/bull-board'
cookie_file='/tmp/bull-board-cookies'

status=$(
  curl -sS \
    --retry 10 \
    --retry-delay 1 \
    --retry-connrefused \
    -o /dev/null \
    -w '%{http_code}' \
    "$base_url/pipelines"
)
test "$status" = '302'

curl -sS \
  -c "$cookie_file" \
  -d 'username=test-user' \
  -d 'password=test-password' \
  "$base_url/login" >/dev/null

pipeline_page=$(curl -sS -b "$cookie_file" "$base_url/pipelines")
printf '%s' "$pipeline_page" | grep -q 'data-page="runs"'
printf '%s' "$pipeline_page" | grep -q '/app/bull-board/pipeline-assets/pipeline-dashboard.js'

runs=$(curl -sS -b "$cookie_file" "$base_url/api/pipelines")
printf '%s' "$runs" | grep -q 'pipeline-test-run'
printf '%s' "$runs" | grep -q 'social-analysis-report'

details=$(curl -sS -b "$cookie_file" "$base_url/api/pipelines/pipeline-test-run")
printf '%s' "$details" | grep -q 'social-analysis-trend'
printf '%s' "$details" | grep -q 'social-analysis-crawl'
printf '%s' "$details" | grep -q 'crawl-invocation'
printf '%s' "$details" | grep -q 'crawl-scope'
printf '%s' "$details" | grep -q 'pietra-pipeline--social-analysis-crawl--crawl-source'

curl -fsS -b "$cookie_file" \
  "$base_url/pipeline-assets/pipeline-dashboard.css" >/dev/null
