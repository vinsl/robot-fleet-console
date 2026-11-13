# The control function (M9, ADR 0062): commands, the robot lock, the registry list, demo mode and the live
# relay of the lock changes. Commands and the lock share one function, because both need the same
# resources: the lock item, the registry read, the audit put, the fan-out and iot:Publish (design D1). It is
# synchronous behind the HTTP API, so it has no retry and no dead-letter queue: a retry would publish a
# command or a lock change twice (ADR 0029). Its business policy is a jsonencode() local, like the others,
# so that the terraform test can read every statement. The routes are declared in api.tf.

locals {
  control_policy = {
    Version = "2012-10-17"
    Statement = concat([
      {
        # Lock items, the command claims, the demo flag and the registry list. Every
        # key is a SITE# partition (the handler checks the site of the caller before any store call). The
        # release of the lock is a conditional delete of the item, so DeleteItem is needed here too.
        Sid       = "FleetStateAndRegistry"
        Effect    = "Allow"
        Action    = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem", "dynamodb:Query"]
        Resource  = [module.data_tables.fleet_table_arn]
        Condition = local.site_keys_condition
      },
      {
        # The audit record of each command, lock change and demo change is a new item: a conditional put only.
        Sid       = "AuditAppend"
        Effect    = "Allow"
        Action    = ["dynamodb:PutItem"]
        Resource  = [module.data_tables.events_table_arn]
        Condition = local.site_keys_condition
      },
      {
        # The subscribed connections of the site, for the lock.changed fan-out (reliable mode, as the alerts).
        Sid      = "SubscribedConnectionsRead"
        Effect   = "Allow"
        Action   = ["dynamodb:Query"]
        Resource = [module.data_tables.connections_site_index_arn]
      },
      {
        # A connection the fan-out cannot reach any more is removed by its CONN# key only.
        Sid       = "StaleConnectionRemove"
        Effect    = "Allow"
        Action    = ["dynamodb:DeleteItem"]
        Resource  = [module.data_tables.connections_table_arn]
        Condition = local.connection_keys_condition
      },
      {
        # Commands are published to the cmd topic of a robot, and to no other topic. The site and robot segments
        # are wildcards on purpose: the function only learns them at runtime, from the verified site and the
        # robot it has just read, so the policy cannot bind them further.
        Sid      = "CommandPublish"
        Effect   = "Allow"
        Action   = ["iot:Publish"]
        Resource = ["${local.iot_arn}:topic/fleet/*/*/cmd"]
      },
    ], local.ws_push_statements)
  }
}

module "control_function" {
  source = "../../modules/lambda-function"

  alarm_topic_arn = module.alarm_topic.topic_arn

  enable_alarms = true

  name        = "mfc-demo-control"
  description = "Commands, robot lock, registry list, demo mode and lock relay, the /sites routes of M9 (synchronous)."
  source_dir  = "${local.api_dist_dir}/control"

  boundary_arn = local.workload_boundary_arn
  role_path    = local.workload_role_path
  policy_json  = jsonencode(local.control_policy)

  # Equal to the 5-second integration timeout of the HTTP API (http-api module). The publish has its own
  # 2-second budget inside the handler, so a slow store call ends as a function timeout, not as a late command.
  timeout     = 5
  memory_size = 256

  # Synchronous: an automatic retry would publish a command or a lock change twice, so no retry and no DLQ.
  maximum_retry_attempts       = 0
  maximum_event_age_in_seconds = 60
  dead_letter_queue_arn        = null

  environment = merge(local.api_function_environment, {
    POWERTOOLS_SERVICE_NAME = "control"
    FLEET_TABLE_NAME        = module.data_tables.fleet_table_name
    EVENTS_TABLE_NAME       = module.data_tables.events_table_name
    CONNECTIONS_TABLE_NAME  = module.data_tables.connections_table_name
    WS_MANAGEMENT_ENDPOINT  = module.websocket_api.management_endpoint
    IOT_DATA_ENDPOINT       = data.aws_iot_endpoint.data.endpoint_address
  })
}
