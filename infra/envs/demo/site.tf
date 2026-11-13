# The site function (M7, SPEC section 4.5): the site profile, the map versions and the GeoJSON files of a
# site. It is synchronous behind the HTTP API, so it has no retry and no dead-letter queue (ADR 0029).
# Its business policy is a jsonencode() local, like the other functions, so that the terraform test can
# read every statement. The site-maps bucket is created here because the function is its only reader
# and writer; the bucket itself lives in infra/modules/site-maps.

module "site_maps" {
  source = "../../modules/site-maps"

  name_prefix      = local.name_prefix
  bucket_suffix    = var.bucket_suffix
  console_origin   = module.web.console_origin
  logs_bucket_name = module.web.logs_bucket_name
}

locals {
  # Site items are the partition SITE#<siteId> of the fleet table. That partition also holds the robot
  # registry items (sort key ROBOT#), and IAM leading keys cannot restrict on the sort key: the function
  # only touches META and MAP# items by construction, and the handler enforces role and site (R74).
  site_keys_condition = { "ForAllValues:StringLike" = { "dynamodb:LeadingKeys" = ["SITE#*"] } }

  site_policy = {
    Version = "2012-10-17"
    Statement = [
      {
        # Reads and writes of the profile (META) and of the map versions (MAP#), the query of the version
        # list and the condition check of the activation transaction.
        Sid       = "SiteProfileAndMaps"
        Effect    = "Allow"
        Action    = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:ConditionCheckItem", "dynamodb:Query"]
        Resource  = [module.data_tables.fleet_table_arn]
        Condition = local.site_keys_condition
      },
      {
        # The activation writes the version check and the profile in one transaction. The per-item actions
        # of the transaction are granted by the statement above; this one only admits the call.
        Sid      = "SiteActivationTransaction"
        Effect   = "Allow"
        Action   = ["dynamodb:TransactWriteItems"]
        Resource = [module.data_tables.fleet_table_arn]
      },
      {
        # The audit record of each admin action is a new item of the events table, a conditional put.
        Sid       = "AuditAppend"
        Effect    = "Allow"
        Action    = ["dynamodb:PutItem"]
        Resource  = [module.data_tables.events_table_arn]
        Condition = local.site_keys_condition
      },
      {
        # Presigned POST of an upload, presigned GET of one version, and the read of one version to validate
        # it. Limited to the sites/ prefix: the bucket holds nothing else today, and the prefix keeps it so.
        # No DeleteObject: a superseded version is kept, and the lifecycle rule of the bucket expires it.
        Sid      = "MapObjects"
        Effect   = "Allow"
        Action   = ["s3:PutObject", "s3:GetObject", "s3:GetObjectVersion"]
        Resource = ["${module.site_maps.bucket_arn}/sites/*"]
      },
      {
        # Without ListBucket, S3 answers a missing key with 403 instead of 404, and the head of a key that
        # does not exist is an expected answer (no map yet). A HeadObject request carries no s3:prefix, so
        # the condition must be StringLikeIfExists: StringLike would never match it. A real listing is
        # still confined to the sites/ prefix, and the code never lists.
        Sid       = "MapKeysExist"
        Effect    = "Allow"
        Action    = ["s3:ListBucket"]
        Resource  = [module.site_maps.bucket_arn]
        Condition = { StringLikeIfExists = { "s3:prefix" = ["sites/*"] } }
      },
    ]
  }
}

module "site_function" {
  source = "../../modules/lambda-function"

  alarm_topic_arn = module.alarm_topic.topic_arn

  enable_alarms = true

  name        = "mfc-demo-site"
  description = "Site profile, map versions, upload, validation and activation, the /sites routes (synchronous)."
  source_dir  = "${local.api_dist_dir}/site"

  boundary_arn = local.workload_boundary_arn
  role_path    = local.workload_role_path
  policy_json  = jsonencode(local.site_policy)

  # Equal to the 5-second integration timeout of the HTTP API (http-api module): a slow call ends as a
  # function timeout, which the gateway reports as a 5xx. Raising one without the other is a reviewed change.
  timeout = 5
  # Validation parses a GeoJSON file of at most 2 MB (SITE_MAP_MAX_BYTES); 256 MB would be too tight for its objects.
  memory_size = 512

  # Synchronous: an automatic retry would repeat an activation or an audit record, so no retry and no DLQ.
  maximum_retry_attempts       = 0
  maximum_event_age_in_seconds = 60
  dead_letter_queue_arn        = null

  environment = merge(local.api_function_environment, {
    POWERTOOLS_SERVICE_NAME = "site"
    FLEET_TABLE_NAME        = module.data_tables.fleet_table_name
    EVENTS_TABLE_NAME       = module.data_tables.events_table_name
    SITE_MAPS_BUCKET_NAME   = module.site_maps.bucket_name
  })
}
