# The audit function (M9, ADR 0064): the paged read of a site's audit records, GET /sites/{siteId}/audit. It
# is read-only by construction: its only grant is a query of the open-alerts index, where every audit record
# is also listed (design D12). It is synchronous behind the HTTP API, so it has no retry and no dead-letter
# queue (ADR 0029). Its business policy is a jsonencode() local, like the others, for the terraform test.

locals {
  audit_policy = {
    Version = "2012-10-17"
    Statement = [
      {
        # The audit partition of the site (SITE#<siteId>#AUDIT) is one partition of the open-alerts index. The
        # handler builds the key from the verified site, and the leading-key condition keeps the query there.
        Sid       = "AuditIndexRead"
        Effect    = "Allow"
        Action    = ["dynamodb:Query"]
        Resource  = [module.data_tables.events_open_alerts_index_arn]
        Condition = local.site_keys_condition
      },
    ]
  }
}

module "audit_function" {
  source = "../../modules/lambda-function"

  alarm_topic_arn = module.alarm_topic.topic_arn

  enable_alarms = true

  name        = "mfc-demo-audit"
  description = "Paged read of the audit trail of a site, GET /sites/{siteId}/audit (synchronous, read-only)."
  source_dir  = "${local.api_dist_dir}/audit"

  boundary_arn = local.workload_boundary_arn
  role_path    = local.workload_role_path
  policy_json  = jsonencode(local.audit_policy)

  timeout     = 5
  memory_size = 256

  # Synchronous and read-only: no retry and no DLQ, as for the other synchronous functions.
  maximum_retry_attempts       = 0
  maximum_event_age_in_seconds = 60
  dead_letter_queue_arn        = null

  environment = merge(local.api_function_environment, {
    POWERTOOLS_SERVICE_NAME = "audit"
    EVENTS_TABLE_NAME       = module.data_tables.events_table_name
  })
}
