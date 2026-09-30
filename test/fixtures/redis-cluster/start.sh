#!/bin/sh
set -eu

ip=$(hostname -i | awk '{print $1}')
for port in 7000 7001 7002; do
  redis-server --port "$port" --cluster-enabled yes \
    --cluster-config-file "/data/nodes-$port.conf" --cluster-announce-ip "$ip" \
    --appendonly no --save '' &
done
trap 'kill $(jobs -p); wait' EXIT

for port in 7000 7001 7002; do
  attempts=0
  until redis-cli -p "$port" ping; do
    attempts=$((attempts + 1))
    test "$attempts" -lt 30
    sleep 1
  done
done
redis-cli --cluster create "$ip:7000" "$ip:7001" "$ip:7002" --cluster-replicas 0 --cluster-yes
wait
