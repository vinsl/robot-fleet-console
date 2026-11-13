# Business permissions of the two Lambda functions of the robot stack. Each is a jsonencode() of a
# local (not an aws_iam_policy_document data source) so that the mocked terraform test can read the
# statements. Every resource is explicit; the only "*" resources are the actions that AWS does not
# scope to a resource (ADR 0029).

locals {
  # The connections table holds two kinds of items under two key prefixes. Each statement that touches it is
  # limited to the prefix it needs, so a function cannot read or write the other kind of item.
  connection_keys_condition = { "ForAllValues:StringLike" = { "dynamodb:LeadingKeys" = ["CONN#*"] } }
  token_keys_condition      = { "ForAllValues:StringLike" = { "dynamodb:LeadingKeys" = ["WSTOKEN#*"] } }

  iot_arn = "arn:aws:iot:${var.region}:${local.account_id}"

  robots_policy = {
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "RegistryReadWrite"
        Effect   = "Allow"
        Action   = ["dynamodb:GetItem", "dynamodb:PutItem"]
        Resource = [module.data_tables.fleet_table_arn]
      },
      {
        Sid      = "AuditAppend"
        Effect   = "Allow"
        Action   = ["dynamodb:PutItem"]
        Resource = [module.data_tables.events_table_arn]
      },
      {
        Sid      = "RobotThings"
        Effect   = "Allow"
        Action   = ["iot:CreateThing", "iot:ListThingPrincipals"]
        Resource = ["${local.iot_arn}:thing/${local.name_prefix}-*"]
      },
      {
        # This action has no resource type: AWS generates the certificate id, so it can only be granted on *. See THREAT_MODEL R20.
        Sid      = "CreateRobotCertificate"
        Effect   = "Allow"
        Action   = ["iot:CreateKeysAndCertificate"]
        Resource = ["*"]
      },
      {
        Sid      = "RobotCertificateLifecycle"
        Effect   = "Allow"
        Action   = ["iot:UpdateCertificate", "iot:AttachPolicy", "iot:DetachPolicy"]
        Resource = ["${local.iot_arn}:cert/*"]
      },
      {
        Sid      = "RobotCertificateThings"
        Effect   = "Allow"
        Action   = ["iot:AttachThingPrincipal", "iot:DetachThingPrincipal"]
        Resource = ["${local.iot_arn}:cert/*"]
        Condition = {
          ArnLike = { "iot:thingArn" = "${local.iot_arn}:thing/${local.name_prefix}-*" }
        }
      },
      {
        Sid      = "DisconnectRobots"
        Effect   = "Allow"
        Action   = ["iot:DeleteConnection"]
        Resource = ["${local.iot_arn}:client/${local.name_prefix}-*"]
      },
      {
        Sid    = "RobotChannels"
        Effect = "Allow"
        Action = [
          "kinesisvideo:CreateSignalingChannel",
          "kinesisvideo:DescribeSignalingChannel",
          "kinesisvideo:DeleteSignalingChannel",
          "kinesisvideo:TagResource",
        ]
        Resource = ["arn:aws:kinesisvideo:${var.region}:${local.account_id}:channel/${local.name_prefix}-*/*"]
      },
    ]
  }

  # Sending to and closing the connections of the WebSocket stage. The API id is in the ARN, which is
  # why ws-message keeps this statement in its own inline policy (see realtime.tf).
  ws_push_statements = [
    {
      Sid      = "ConnectionsPushAndClose"
      Effect   = "Allow"
      Action   = ["execute-api:ManageConnections"]
      Resource = ["${module.websocket_api.stage_arn}/POST/@connections/*", "${module.websocket_api.stage_arn}/DELETE/@connections/*"]
    },
  ]

  ws_token_policy = {
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "TokenStore"
        Effect    = "Allow"
        Action    = ["dynamodb:PutItem"]
        Resource  = [module.data_tables.connections_table_arn]
        Condition = local.token_keys_condition
      },
    ]
  }

  ws_connect_policy = {
    Version = "2012-10-17"
    Statement = [
      {
        # DeleteItem with ALL_OLD redeems the token in one atomic step.
        Sid       = "TokenRedeem"
        Effect    = "Allow"
        Action    = ["dynamodb:DeleteItem"]
        Resource  = [module.data_tables.connections_table_arn]
        Condition = local.token_keys_condition
      },
      {
        Sid       = "ConnectionRecordWrite"
        Effect    = "Allow"
        Action    = ["dynamodb:PutItem"]
        Resource  = [module.data_tables.connections_table_arn]
        Condition = local.connection_keys_condition
      },
    ]
  }

  ws_disconnect_policy = {
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "ConnectionRecordRemove"
        Effect    = "Allow"
        Action    = ["dynamodb:DeleteItem"]
        Resource  = [module.data_tables.connections_table_arn]
        Condition = local.connection_keys_condition
      },
    ]
  }

  ws_message_policy = {
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "ConnectionRecordReadAndSubscribe"
        Effect    = "Allow"
        Action    = ["dynamodb:GetItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem"]
        Resource  = [module.data_tables.connections_table_arn]
        Condition = local.connection_keys_condition
      },
      {
        Sid      = "FleetSnapshot"
        Effect   = "Allow"
        Action   = ["dynamodb:Query"]
        Resource = [module.data_tables.fleet_table_arn]
      },
      {
        # The lock item of a robot: read to check the holder and the expiry, and refreshed (conditionally on the
        # holder and token) when it is close to expiry. Keys are SITE# partitions only.
        Sid       = "LockReadAndRefresh"
        Effect    = "Allow"
        Action    = ["dynamodb:GetItem", "dynamodb:UpdateItem"]
        Resource  = [module.data_tables.fleet_table_arn]
        Condition = local.site_keys_condition
      },
      {
        # The HEARTBEAT command of a verified holder, published to the cmd topic of one robot and no other topic.
        Sid      = "HeartbeatPublish"
        Effect   = "Allow"
        Action   = ["iot:Publish"]
        Resource = ["${local.iot_arn}:topic/fleet/*/*/cmd"]
      },
    ]
  }

  # The management grant of ws-message, the only statement of its inline policy (realtime.tf).
  ws_message_connections_policy = {
    Version   = "2012-10-17"
    Statement = local.ws_push_statements
  }

  ingest_telemetry_policy = {
    Version = "2012-10-17"
    Statement = concat([
      {
        Sid      = "TelemetryQueueConsumer"
        Effect   = "Allow"
        Action   = ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes", "sqs:ChangeMessageVisibility"]
        Resource = [module.queues.telemetry_queue_arn]
      },
      {
        # Conditional UpdateItem only: the live state of a robot is never read-modify-written.
        Sid      = "FleetStateObserve"
        Effect   = "Allow"
        Action   = ["dynamodb:UpdateItem"]
        Resource = [module.data_tables.fleet_table_arn]
      },
      {
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

  ingest_events_policy = {
    Version = "2012-10-17"
    Statement = concat([
      {
        Sid      = "DeadLetterQueue"
        Effect   = "Allow"
        Action   = ["sqs:SendMessage"]
        Resource = [module.queues.ingest_events_dlq_arn]
      },
      {
        # Presence and state use conditional updates and reads of the robot record, and the alert
        # transaction puts its marker in the same table (design section 4.4).
        Sid      = "FleetStateAndAlertMarkers"
        Effect   = "Allow"
        Action   = ["dynamodb:GetItem", "dynamodb:UpdateItem", "dynamodb:PutItem"]
        Resource = [module.data_tables.fleet_table_arn]
      },
      {
        # Alerts and state history are new items only: a conditional put, never an overwrite.
        Sid      = "EventHistoryAndAlerts"
        Effect   = "Allow"
        Action   = ["dynamodb:PutItem"]
        Resource = [module.data_tables.events_table_arn]
      },
      {
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
