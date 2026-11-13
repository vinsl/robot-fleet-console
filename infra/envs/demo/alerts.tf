# The alerts function (M8, SPEC section 4.3 and section 8): the list of a site's alerts, and the
# acknowledgement and resolution of one alert by an operator. It is synchronous behind the HTTP API, so
# it has no retry and no dead-letter queue: a retry would repeat a transition or an audit record (ADR 0029).
# Its business policy is a jsonencode() local, like the other functions, so that the terraform test can
# read every statement. The routes are declared in api.tf.

locals {
  # Alert items and audit records live in the events table, the alert marker in the fleet table. Their
  # partition keys are SITE#<siteId> (the handler checks the site of the caller before any store call).
  # The openAlerts index is keyed by SITE#<siteId>#OPEN and SITE#<siteId>#RESOLVED, which also match SITE#*.
  alerts_policy = {
    Version = "2012-10-17"
    Statement = concat([
      {
        # Strongly consistent read of one alert by its exact key, then the conditional update of its status.
        Sid       = "AlertReadAndUpdate"
        Effect    = "Allow"
        Action    = ["dynamodb:GetItem", "dynamodb:UpdateItem"]
        Resource  = [module.data_tables.events_table_arn]
        Condition = local.site_keys_condition
      },
      {
        # The audit record of each transition is a new item of the events table, a conditional put.
        Sid       = "AuditAppend"
        Effect    = "Allow"
        Action    = ["dynamodb:PutItem"]
        Resource  = [module.data_tables.events_table_arn]
        Condition = local.site_keys_condition
      },
      {
        # The list of open alerts and of the resolved history, one partition per status of the site.
        Sid       = "AlertStatusIndexRead"
        Effect    = "Allow"
        Action    = ["dynamodb:Query"]
        Resource  = [module.data_tables.events_open_alerts_index_arn]
        Condition = local.site_keys_condition
      },
      {
        # Resolution removes the marker of the robot condition in the same transaction (R47).
        Sid       = "AlertMarkerDelete"
        Effect    = "Allow"
        Action    = ["dynamodb:DeleteItem"]
        Resource  = [module.data_tables.fleet_table_arn]
        Condition = local.site_keys_condition
      },
      {
        # Each transition is one TransactWriteItems call. The per-item actions of the transaction are granted
        # by the statements above; this one only admits the call.
        Sid      = "AlertTransaction"
        Effect   = "Allow"
        Action   = ["dynamodb:TransactWriteItems"]
        Resource = [module.data_tables.events_table_arn, module.data_tables.fleet_table_arn]
      },
      {
        # Fan-out of alert.changed to the subscribed connections of the site (reliable mode, as ingest-events).
        Sid      = "SubscribedConnectionsRead"
        Effect   = "Allow"
        Action   = ["dynamodb:Query"]
        Resource = [module.data_tables.connections_site_index_arn]
      },
      {
        Sid       = "StaleConnectionRemove"
        Effect    = "Allow"
        Action    = ["dynamodb:DeleteItem"]
        Resource  = [module.data_tables.connections_table_arn]
        Condition = local.connection_keys_condition
      },
    ], local.ws_push_statements)
  }
}

module "alerts_function" {
  source = "../../modules/lambda-function"

  alarm_topic_arn = module.alarm_topic.topic_arn

  enable_alarms = true

  name        = "mfc-demo-alerts"
  description = "Alert list, acknowledgement and resolution, the /sites/{siteId}/alerts routes (synchronous)."
  source_dir  = "${local.api_dist_dir}/alerts"

  boundary_arn = local.workload_boundary_arn
  role_path    = local.workload_role_path
  policy_json  = jsonencode(local.alerts_policy)

  # Equal to the 5-second integration timeout of the HTTP API (http-api module), as the site function.
  timeout     = 5
  memory_size = 256

  # Synchronous: an automatic retry would repeat a transition or an audit record, so no retry and no DLQ.
  maximum_retry_attempts       = 0
  maximum_event_age_in_seconds = 60
  dead_letter_queue_arn        = null

  environment = merge(local.api_function_environment, {
    POWERTOOLS_SERVICE_NAME = "alerts"
    FLEET_TABLE_NAME        = module.data_tables.fleet_table_name
    EVENTS_TABLE_NAME       = module.data_tables.events_table_name
    CONNECTIONS_TABLE_NAME  = module.data_tables.connections_table_name
    WS_MANAGEMENT_ENDPOINT  = module.websocket_api.management_endpoint
  })
}
