# The robot stack (ADR 0029): data, queues, robot identity, the two functions and the topic rules.
# The robots function is invoked directly with IAM, so it has no resource policy and no event
# source; the ingest-events function is invoked only by the IoT rules, through permissions that
# iot-rules creates.

module "data_tables" {
  source      = "../../modules/data-tables"
  name_prefix = local.name_prefix
}

module "queues" {
  source          = "../../modules/queues"
  name_prefix     = local.name_prefix
  alarm_topic_arn = module.alarm_topic.topic_arn
}

module "robot_iot" {
  source       = "../../modules/robot-iot"
  name_prefix  = local.name_prefix
  account_id   = local.account_id
  region       = var.region
  boundary_arn = local.workload_boundary_arn
  role_path    = local.workload_role_path
}

module "robots_function" {
  source = "../../modules/lambda-function"

  alarm_topic_arn = module.alarm_topic.topic_arn

  enable_alarms = true

  name        = "mfc-demo-robots"
  description = "Registers and retires robots (IAM-invoked, synchronous only)."
  source_dir  = "${local.api_dist_dir}/robots"

  boundary_arn = local.workload_boundary_arn
  role_path    = local.workload_role_path
  policy_json  = jsonencode(local.robots_policy)

  timeout     = 30
  memory_size = 256

  # Synchronous: an automatic retry would repeat a registration, so no retry and no DLQ (ADR 0029).
  maximum_retry_attempts       = 0
  maximum_event_age_in_seconds = 60
  dead_letter_queue_arn        = null

  environment = {
    POWERTOOLS_SERVICE_NAME            = "robots"
    POWERTOOLS_METRICS_NAMESPACE       = "mfc-demo"
    POWERTOOLS_LOG_LEVEL               = "INFO"
    POWERTOOLS_TRACER_CAPTURE_RESPONSE = "false"
    POWERTOOLS_TRACER_CAPTURE_ERROR    = "false"
    NODE_OPTIONS                       = "--enable-source-maps"
    FLEET_TABLE_NAME                   = module.data_tables.fleet_table_name
    EVENTS_TABLE_NAME                  = module.data_tables.events_table_name
    IOT_DATA_ENDPOINT                  = data.aws_iot_endpoint.data.endpoint_address
    IOT_CREDENTIALS_ENDPOINT           = data.aws_iot_endpoint.credentials.endpoint_address
    RESOURCE_TAGS                      = jsonencode(local.default_tags)
  }
}

module "ingest_events_function" {
  source = "../../modules/lambda-function"

  alarm_topic_arn = module.alarm_topic.topic_arn

  enable_alarms = true

  name        = "mfc-demo-ingest-events"
  description = "Validates robot events, acks and presence from the IoT rules."
  source_dir  = "${local.api_dist_dir}/ingest-events"

  boundary_arn = local.workload_boundary_arn
  role_path    = local.workload_role_path
  policy_json  = jsonencode(local.ingest_events_policy)

  timeout     = 10
  memory_size = 256

  # Asynchronous (invoked by IoT): two retries, then the DLQ; events older than five minutes are dropped.
  maximum_retry_attempts       = 2
  maximum_event_age_in_seconds = 300
  dead_letter_queue_arn        = module.queues.ingest_events_dlq_arn

  environment = {
    POWERTOOLS_SERVICE_NAME            = "ingest-events"
    POWERTOOLS_METRICS_NAMESPACE       = "mfc-demo"
    POWERTOOLS_LOG_LEVEL               = "INFO"
    POWERTOOLS_TRACER_CAPTURE_RESPONSE = "false"
    NODE_OPTIONS                       = "--enable-source-maps"
    FLEET_TABLE_NAME                   = module.data_tables.fleet_table_name
    EVENTS_TABLE_NAME                  = module.data_tables.events_table_name
    CONNECTIONS_TABLE_NAME             = module.data_tables.connections_table_name
    WS_MANAGEMENT_ENDPOINT             = module.websocket_api.management_endpoint
  }
}

module "iot_rules" {
  source = "../../modules/iot-rules"

  name_prefix     = local.name_prefix
  account_id      = local.account_id
  region          = var.region
  boundary_arn    = local.workload_boundary_arn
  role_path       = local.workload_role_path
  alarm_topic_arn = module.alarm_topic.topic_arn

  telemetry_queue_url = module.queues.telemetry_queue_url
  telemetry_queue_arn = module.queues.telemetry_queue_arn
  errors_queue_url    = module.queues.rule_errors_queue_url
  errors_queue_arn    = module.queues.rule_errors_queue_arn

  ingest_events_function_arn  = module.ingest_events_function.function_arn
  ingest_events_function_name = module.ingest_events_function.function_name
}
