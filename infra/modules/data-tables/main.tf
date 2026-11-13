# DynamoDB tables of the fleet (SPEC section 8): the registry (fleet) and the events (audit trail and
# robot events). Both use on-demand capacity, point-in-time recovery and a TTL on expiresAt.

resource "aws_dynamodb_table" "fleet" {
  #checkov:skip=CKV_AWS_119:AWS-owned encryption key instead of a customer-managed key: SPEC section 11 excludes custom keys for cost (THREAT_MODEL R2).
  name         = "${var.name_prefix}-fleet"
  billing_mode = "PAY_PER_REQUEST"

  hash_key  = "pk"
  range_key = "sk"

  attribute {
    name = "pk"
    type = "S"
  }

  attribute {
    name = "sk"
    type = "S"
  }

  point_in_time_recovery {
    enabled = true
  }

  ttl {
    attribute_name = "expiresAt"
    enabled        = true
  }
}

resource "aws_dynamodb_table" "events" {
  #checkov:skip=CKV_AWS_119:AWS-owned encryption key instead of a customer-managed key: SPEC section 11 excludes custom keys for cost (THREAT_MODEL R2).
  name         = "${var.name_prefix}-events"
  billing_mode = "PAY_PER_REQUEST"

  hash_key  = "pk"
  range_key = "sk"

  attribute {
    name = "pk"
    type = "S"
  }

  attribute {
    name = "sk"
    type = "S"
  }

  attribute {
    name = "byRobotPk"
    type = "S"
  }

  attribute {
    name = "byRobotSk"
    type = "S"
  }

  attribute {
    name = "openAlertPk"
    type = "S"
  }

  attribute {
    name = "openAlertSk"
    type = "S"
  }

  # Robot history: all the events of one robot, ordered by time.
  global_secondary_index {
    name            = "byRobot"
    projection_type = "ALL"

    key_schema {
      attribute_name = "byRobotPk"
      key_type       = "HASH"
    }

    key_schema {
      attribute_name = "byRobotSk"
      key_type       = "RANGE"
    }
  }

  # Open alerts across the fleet (used from M6 on).
  global_secondary_index {
    name            = "openAlerts"
    projection_type = "ALL"

    key_schema {
      attribute_name = "openAlertPk"
      key_type       = "HASH"
    }

    key_schema {
      attribute_name = "openAlertSk"
      key_type       = "RANGE"
    }
  }

  point_in_time_recovery {
    enabled = true
  }

  ttl {
    attribute_name = "expiresAt"
    enabled        = true
  }
}

# Live WebSocket state (M5, SPEC section 8, design section 2.3). Two kinds of items share the table:
# connection records (CONN#<id>) and single-use token hashes (WSTOKEN#<sha256>). Both expire through
# expiresAt. The sparse bySite index only sees the connections that subscribed to a site (sitePk).
# Point-in-time recovery is off on purpose: the items are ephemeral and a restore would revive
# sessions and tokens that must be dead.

resource "aws_dynamodb_table" "connections" {
  #checkov:skip=CKV_AWS_119:AWS-owned encryption key instead of a customer-managed key: SPEC section 11 excludes custom keys for cost (THREAT_MODEL R2).
  #checkov:skip=CKV_AWS_28:Point-in-time recovery off on purpose: connection and token items are ephemeral (TTL 60 s to 2 h) and a restore would revive dead sessions and tokens.
  name         = "${var.name_prefix}-connections"
  billing_mode = "PAY_PER_REQUEST"

  hash_key = "pk"

  attribute {
    name = "pk"
    type = "S"
  }

  attribute {
    name = "sitePk"
    type = "S"
  }

  # Connections subscribed to one site, used by the fan-out (sparse: only subscribed connections).
  global_secondary_index {
    name            = "bySite"
    projection_type = "INCLUDE"
    non_key_attributes = [
      "role",
      "sessionExpiresAtMs",
    ]

    key_schema {
      attribute_name = "sitePk"
      key_type       = "HASH"
    }

    key_schema {
      attribute_name = "pk"
      key_type       = "RANGE"
    }
  }

  ttl {
    attribute_name = "expiresAt"
    enabled        = true
  }
}
