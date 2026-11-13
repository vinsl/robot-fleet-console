# The live WebSocket stack (M5, ADR 0041): the WebSocket API and its four functions. Every function
# is synchronous (API Gateway or an IAM caller waits for it), so none retries and none has a
# dead-letter queue: a retry would repeat a token redemption or a push (ADR 0029). Each one has its
# own role, carries the workload boundary, and gets only the actions of iam.tf.

module "websocket_api" {
  source = "../../modules/websocket-api"

  name_prefix = local.name_prefix
  region      = var.region

  routes = {
    connect    = { function_arn = module.ws_connect_function.function_arn, function_name = module.ws_connect_function.function_name }
    disconnect = { function_arn = module.ws_disconnect_function.function_arn, function_name = module.ws_disconnect_function.function_name }
    default    = { function_arn = module.ws_message_function.function_arn, function_name = module.ws_message_function.function_name }
  }
}

# Issues the single-use token. Invoked with IAM by the operator only: no route and no resource
# policy point at it (design section 5, M6 replaces the invocation path).
module "ws_token_function" {
  source = "../../modules/lambda-function"

  alarm_topic_arn = module.alarm_topic.topic_arn

  enable_alarms = true

  name        = "mfc-demo-ws-token"
  description = "Issues the single-use WebSocket token for one user and one site (IAM-invoked, synchronous)."
  source_dir  = "${local.api_dist_dir}/ws-token"

  boundary_arn = local.workload_boundary_arn
  role_path    = local.workload_role_path
  policy_json  = jsonencode(local.ws_token_policy)

  timeout     = 5
  memory_size = 256

  maximum_retry_attempts       = 0
  maximum_event_age_in_seconds = 60
  dead_letter_queue_arn        = null

  environment = {
    POWERTOOLS_SERVICE_NAME            = "ws-token"
    POWERTOOLS_METRICS_NAMESPACE       = "mfc-demo"
    POWERTOOLS_LOG_LEVEL               = "INFO"
    POWERTOOLS_TRACER_CAPTURE_RESPONSE = "false"
    POWERTOOLS_TRACER_CAPTURE_ERROR    = "false"
    NODE_OPTIONS                       = "--enable-source-maps"
    CONNECTIONS_TABLE_NAME             = module.data_tables.connections_table_name
    WS_URL                             = module.websocket_api.ws_url
  }
}

# Redeems the token at $connect and writes the connection record. The origin allow-list is passed
# as a JSON array, the same encoding as RESOURCE_TAGS.
module "ws_connect_function" {
  source = "../../modules/lambda-function"

  alarm_topic_arn = module.alarm_topic.topic_arn

  enable_alarms = true

  name        = "mfc-demo-ws-connect"
  description = "Redeems the WebSocket token at $connect and records the connection (synchronous)."
  source_dir  = "${local.api_dist_dir}/ws-connect"

  boundary_arn = local.workload_boundary_arn
  role_path    = local.workload_role_path
  policy_json  = jsonencode(local.ws_connect_policy)

  timeout     = 5
  memory_size = 256

  maximum_retry_attempts       = 0
  maximum_event_age_in_seconds = 60
  dead_letter_queue_arn        = null

  environment = {
    POWERTOOLS_SERVICE_NAME            = "ws-connect"
    POWERTOOLS_METRICS_NAMESPACE       = "mfc-demo"
    POWERTOOLS_LOG_LEVEL               = "INFO"
    POWERTOOLS_TRACER_CAPTURE_RESPONSE = "false"
    POWERTOOLS_TRACER_CAPTURE_ERROR    = "false"
    NODE_OPTIONS                       = "--enable-source-maps"
    CONNECTIONS_TABLE_NAME             = module.data_tables.connections_table_name
    WS_ALLOWED_ORIGINS                 = jsonencode(distinct(concat([module.web.console_origin], var.ws_allowed_origins)))
  }
}

module "ws_disconnect_function" {
  source = "../../modules/lambda-function"

  alarm_topic_arn = module.alarm_topic.topic_arn

  enable_alarms = true

  name        = "mfc-demo-ws-disconnect"
  description = "Removes the connection record when a WebSocket closes (synchronous)."
  source_dir  = "${local.api_dist_dir}/ws-disconnect"

  boundary_arn = local.workload_boundary_arn
  role_path    = local.workload_role_path
  policy_json  = jsonencode(local.ws_disconnect_policy)

  timeout     = 5
  memory_size = 256

  maximum_retry_attempts       = 0
  maximum_event_age_in_seconds = 60
  dead_letter_queue_arn        = null

  environment = {
    POWERTOOLS_SERVICE_NAME            = "ws-disconnect"
    POWERTOOLS_METRICS_NAMESPACE       = "mfc-demo"
    POWERTOOLS_LOG_LEVEL               = "INFO"
    POWERTOOLS_TRACER_CAPTURE_RESPONSE = "false"
    POWERTOOLS_TRACER_CAPTURE_ERROR    = "false"
    NODE_OPTIONS                       = "--enable-source-maps"
    CONNECTIONS_TABLE_NAME             = module.data_tables.connections_table_name
  }
}

# Handles client messages (subscribe, ping, heartbeat). The management endpoint is not in its
# environment: it would make the function depend on the API that routes to it. The handler derives
# it from the request context of each event, and the IAM grant below carries the API id instead.
module "ws_message_function" {
  source = "../../modules/lambda-function"

  alarm_topic_arn = module.alarm_topic.topic_arn

  enable_alarms = true

  name        = "mfc-demo-ws-message"
  description = "Handles client messages of the live console: subscribe, ping, heartbeat (synchronous)."
  source_dir  = "${local.api_dist_dir}/ws-message"

  boundary_arn = local.workload_boundary_arn
  role_path    = local.workload_role_path
  policy_json  = jsonencode(local.ws_message_policy)

  timeout     = 5
  memory_size = 256

  maximum_retry_attempts       = 0
  maximum_event_age_in_seconds = 60
  dead_letter_queue_arn        = null

  environment = {
    POWERTOOLS_SERVICE_NAME            = "ws-message"
    POWERTOOLS_METRICS_NAMESPACE       = "mfc-demo"
    POWERTOOLS_LOG_LEVEL               = "INFO"
    POWERTOOLS_TRACER_CAPTURE_RESPONSE = "false"
    POWERTOOLS_TRACER_CAPTURE_ERROR    = "false"
    NODE_OPTIONS                       = "--enable-source-maps"
    CONNECTIONS_TABLE_NAME             = module.data_tables.connections_table_name
    FLEET_TABLE_NAME                   = module.data_tables.fleet_table_name
    # The data-plane endpoint of IoT: the heartbeat path publishes HEARTBEAT commands to the robot (ADR 0063).
    IOT_DATA_ENDPOINT = data.aws_iot_endpoint.data.endpoint_address
  }
}

# A failed heartbeat publish means the robot is not being fed: the deadman will pause it within about a second.
# The alarm tells the operator at once. The metric is emitted by the function's Powertools logger with the
# service dimension of ws-message.
# Period 300 s with one evaluation: a single failed publish is enough to alarm, and the 5-minute window matches
# the other function alarms of the stack (ADR 0023). notBreaching: the metric is only emitted when a publish
# fails, so a missing datapoint means no failure, which is the healthy state when no robot holds a lock.
resource "aws_cloudwatch_metric_alarm" "heartbeat_publish_failed" {
  alarm_name          = "${local.name_prefix}-ws-message-heartbeat-publish-failed"
  alarm_description   = "The ws-message function could not publish a heartbeat to a robot: the robot pauses when its deadman expires."
  namespace           = "mfc-demo"
  metric_name         = "HeartbeatPublishFailed"
  dimensions          = { service = "ws-message" }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [module.alarm_topic.topic_arn]
  ok_actions          = [module.alarm_topic.topic_arn]
}

# Sending to connections of this API only. It is a separate inline policy, not part of the business
# policy: the business policy would name the API id, and the API routes to this function, which
# would be a dependency cycle. The grant is still limited to this API, the stage and the two
# @connections operations.
resource "aws_iam_role_policy" "ws_message_connections" {
  name   = "${local.name_prefix}-ws-message-connections"
  role   = module.ws_message_function.role_name
  policy = jsonencode(local.ws_message_connections_policy)
}
