# Telemetry ingest (M5, ADR 0038): the queue of robot telemetry is read by ingest-telemetry in
# batches. The queue is the only event source of the function, so its redrive policy is the
# dead-letter path: a function-level DLQ would never receive a message.

module "ingest_telemetry_function" {
  source = "../../modules/lambda-function"

  alarm_topic_arn = module.alarm_topic.topic_arn

  enable_alarms = true

  name        = "mfc-demo-ingest-telemetry"
  description = "Persists live robot state and pushes fleet deltas to subscribed connections (SQS-triggered)."
  source_dir  = "${local.api_dist_dir}/ingest-telemetry"

  boundary_arn = local.workload_boundary_arn
  role_path    = local.workload_role_path
  policy_json  = jsonencode(local.ingest_telemetry_policy)

  # The visibility timeout of the telemetry queue is 60 s: at least six times this timeout (pinned
  # by ingest.tftest.hcl), so a batch is not redelivered while it is still processed.
  timeout     = 10
  memory_size = 256

  # Event source mapping: the retry and the event age of an asynchronous invocation do not apply.
  maximum_retry_attempts       = 0
  maximum_event_age_in_seconds = 60
  dead_letter_queue_arn        = null

  environment = {
    POWERTOOLS_SERVICE_NAME            = "ingest-telemetry"
    POWERTOOLS_METRICS_NAMESPACE       = "mfc-demo"
    POWERTOOLS_LOG_LEVEL               = "INFO"
    POWERTOOLS_TRACER_CAPTURE_RESPONSE = "false"
    POWERTOOLS_TRACER_CAPTURE_ERROR    = "false"
    NODE_OPTIONS                       = "--enable-source-maps"
    FLEET_TABLE_NAME                   = module.data_tables.fleet_table_name
    CONNECTIONS_TABLE_NAME             = module.data_tables.connections_table_name
    WS_MANAGEMENT_ENDPOINT             = module.websocket_api.management_endpoint
  }
}

# The mapping is disabled and enabled by scripts/demo-consumer.sh (make demo-stop and demo-start).
# Terraform does not own the enabled flag: a deploy must not re-enable a consumer that the operator
# stopped on purpose (THREAT_MODEL R38).
resource "aws_lambda_event_source_mapping" "telemetry" {
  event_source_arn                   = module.queues.telemetry_queue_arn
  function_name                      = module.ingest_telemetry_function.function_arn
  batch_size                         = 100
  maximum_batching_window_in_seconds = var.telemetry_batch_window_seconds
  function_response_types            = ["ReportBatchItemFailures"]
  enabled                            = true

  scaling_config {
    maximum_concurrency = 5
  }

  # The role policy must exist before AWS validates the mapping against the queue.
  depends_on = [module.ingest_telemetry_function]

  lifecycle {
    ignore_changes = [enabled]
  }
}
