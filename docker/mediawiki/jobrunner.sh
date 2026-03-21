#!/bin/bash
set -e

while true; do
    php maintenance/runJobs.php --wait --maxjobs=10 || true
    sleep 5
done
