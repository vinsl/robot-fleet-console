# Executable checks of the data-tables module (SPEC section 8): the names, the keys, the on-demand
# capacity, point-in-time recovery, the TTL on expiresAt, and the two GSIs of the events table.
# Runs use a mocked provider, so no credentials and no AWS call are needed.

mock_provider "aws" {}

# The ARN of a table is known only after apply with the mocked provider; the plan needs it to read the
# index ARN, so the events table gets a fixed ARN for the plan.
override_resource {
  target          = aws_dynamodb_table.events
  override_during = plan
  values          = { arn = "arn:aws:dynamodb:eu-west-3:123456789012:table/mfc-demo-events" }
}

variables {
  name_prefix = "mfc-demo"
}

run "tables_are_named_and_keyed_by_pk_and_sk" {
  command = plan

  module {
    source = "../../modules/data-tables"
  }

  assert {
    condition     = aws_dynamodb_table.fleet.name == "mfc-demo-fleet" && aws_dynamodb_table.events.name == "mfc-demo-events"
    error_message = "the tables must be mfc-demo-fleet and mfc-demo-events"
  }

  assert {
    condition     = alltrue([for t in [aws_dynamodb_table.fleet, aws_dynamodb_table.events] : t.hash_key == "pk" && t.range_key == "sk" && t.billing_mode == "PAY_PER_REQUEST"])
    error_message = "both tables must use pk and sk keys and on-demand capacity"
  }
}

run "tables_keep_point_in_time_recovery_and_ttl" {
  command = plan

  module {
    source = "../../modules/data-tables"
  }

  assert {
    condition     = alltrue([for t in [aws_dynamodb_table.fleet, aws_dynamodb_table.events] : t.point_in_time_recovery[0].enabled && t.ttl[0].enabled && t.ttl[0].attribute_name == "expiresAt"])
    error_message = "both tables must keep point-in-time recovery and expire items on expiresAt"
  }
}

run "events_table_has_the_robot_and_open_alert_indexes" {
  command = plan

  module {
    source = "../../modules/data-tables"
  }

  assert {
    condition     = toset([for g in aws_dynamodb_table.events.global_secondary_index : g.name]) == toset(["byRobot", "openAlerts"])
    error_message = "the events table must have exactly the byRobot and openAlerts indexes"
  }

  assert {
    condition     = alltrue([for g in aws_dynamodb_table.events.global_secondary_index : g.projection_type == "ALL"])
    error_message = "both indexes must project every attribute"
  }

  assert {
    condition     = toset([for k in one([for g in aws_dynamodb_table.events.global_secondary_index : g if g.name == "byRobot"]).key_schema : "${k.attribute_name}:${k.key_type}"]) == toset(["byRobotPk:HASH", "byRobotSk:RANGE"])
    error_message = "the byRobot index must be keyed by byRobotPk and byRobotSk"
  }

  assert {
    condition     = toset([for k in one([for g in aws_dynamodb_table.events.global_secondary_index : g if g.name == "openAlerts"]).key_schema : "${k.attribute_name}:${k.key_type}"]) == toset(["openAlertPk:HASH", "openAlertSk:RANGE"])
    error_message = "the openAlerts index must be keyed by openAlertPk and openAlertSk"
  }
}

run "open_alerts_index_arn_is_the_events_table_index" {
  command = plan

  module {
    source = "../../modules/data-tables"
  }

  assert {
    condition     = output.events_open_alerts_index_arn == "arn:aws:dynamodb:eu-west-3:123456789012:table/mfc-demo-events/index/openAlerts"
    error_message = "the open alerts index ARN must be the openAlerts index of the events table, the one the alerts function queries"
  }
}

run "connections_table_is_keyed_by_pk_with_the_bysite_index" {
  command = plan

  module {
    source = "../../modules/data-tables"
  }

  assert {
    condition     = aws_dynamodb_table.connections.name == "mfc-demo-connections" && aws_dynamodb_table.connections.hash_key == "pk" && aws_dynamodb_table.connections.range_key == null && aws_dynamodb_table.connections.billing_mode == "PAY_PER_REQUEST"
    error_message = "the connections table must be mfc-demo-connections, hash key pk only, on-demand"
  }

  assert {
    condition     = toset([for g in aws_dynamodb_table.connections.global_secondary_index : g.name]) == toset(["bySite"])
    error_message = "the connections table must have exactly the bySite index"
  }

  assert {
    condition     = one(aws_dynamodb_table.connections.global_secondary_index).projection_type == "INCLUDE" && toset(one(aws_dynamodb_table.connections.global_secondary_index).non_key_attributes) == toset(["role", "sessionExpiresAtMs"])
    error_message = "bySite must project only role, sub and sessionExpiresAtMs"
  }

  assert {
    condition     = toset([for k in one(aws_dynamodb_table.connections.global_secondary_index).key_schema : "${k.attribute_name}:${k.key_type}"]) == toset(["sitePk:HASH", "pk:RANGE"])
    error_message = "bySite must be keyed by sitePk and pk"
  }
}

run "connections_table_expires_items_and_keeps_no_point_in_time_recovery" {
  command = plan

  module {
    source = "../../modules/data-tables"
  }

  assert {
    condition     = aws_dynamodb_table.connections.ttl[0].enabled && aws_dynamodb_table.connections.ttl[0].attribute_name == "expiresAt"
    error_message = "the connections table must expire items on expiresAt"
  }

  assert {
    condition     = alltrue([for p in aws_dynamodb_table.connections.point_in_time_recovery : !p.enabled])
    error_message = "point-in-time recovery must stay off for the connections table (ephemeral items)"
  }
}
