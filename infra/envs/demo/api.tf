# The HTTP API of the console (M6, ADR 0047; site routes M7): each route calls one Lambda function with
# its own role. None of the functions retries or has a dead-letter queue: they are synchronous, so API
# Gateway waits for them and a retry would repeat the effect (ADR 0029). The routes are the public
# liveness probe, the identity of the caller, the issue of a WebSocket token (ws-token-http, which reuses
# the business policy of ws-token, ADR 0041), the site configuration and map versions (site.tf) and the
# alerts (alerts.tf).

locals {
  api_function_environment = {
    POWERTOOLS_METRICS_NAMESPACE       = "mfc-demo"
    POWERTOOLS_LOG_LEVEL               = "INFO"
    POWERTOOLS_TRACER_CAPTURE_RESPONSE = "false"
    POWERTOOLS_TRACER_CAPTURE_ERROR    = "false"
    NODE_OPTIONS                       = "--enable-source-maps"
  }
}

module "http_api" {
  source = "../../modules/http-api"

  name_prefix         = local.name_prefix
  console_origin      = module.web.console_origin
  user_pool_endpoint  = module.identity.user_pool_endpoint
  user_pool_client_id = module.identity.user_pool_client_id
  alarm_topic_arn     = module.alarm_topic.topic_arn
  enable_dev_origin   = var.enable_dev_origin

  routes = {
    health = {
      method         = "GET"
      path           = "/health"
      function_arn   = module.health_function.function_arn
      function_name  = module.health_function.function_name
      authorized     = false
      throttle_rate  = 10
      throttle_burst = 20
    }
    me = {
      method        = "GET"
      path          = "/me"
      function_arn  = module.me_function.function_arn
      function_name = module.me_function.function_name
      authorized    = true
    }
    ws_token = {
      method         = "POST"
      path           = "/ws-token"
      function_arn   = module.http_ws_token_function.function_arn
      function_name  = module.http_ws_token_function.function_name
      authorized     = true
      throttle_rate  = 5
      throttle_burst = 10
    }

    # Site configuration and map versions (M7, SPEC section 4.5). Every route is JWT-protected; the role
    # matrix is enforced in the function (services/api/src/domain/site/route.ts).
    site_get = {
      method        = "GET"
      path          = "/sites/{siteId}"
      function_arn  = module.site_function.function_arn
      function_name = module.site_function.function_name
      authorized    = true
    }
    site_update = {
      method        = "PUT"
      path          = "/sites/{siteId}"
      function_arn  = module.site_function.function_arn
      function_name = module.site_function.function_name
      authorized    = true
    }
    site_maps_list = {
      method        = "GET"
      path          = "/sites/{siteId}/maps"
      function_arn  = module.site_function.function_arn
      function_name = module.site_function.function_name
      authorized    = true
    }
    site_map_create = {
      method        = "POST"
      path          = "/sites/{siteId}/maps"
      function_arn  = module.site_function.function_arn
      function_name = module.site_function.function_name
      authorized    = true
    }
    site_map_url = {
      method        = "GET"
      path          = "/sites/{siteId}/maps/{version}"
      function_arn  = module.site_function.function_arn
      function_name = module.site_function.function_name
      authorized    = true
    }
    site_map_validate = {
      method        = "POST"
      path          = "/sites/{siteId}/maps/{version}/validate"
      function_arn  = module.site_function.function_arn
      function_name = module.site_function.function_name
      authorized    = true
    }
    site_map_activate = {
      method         = "POST"
      path           = "/sites/{siteId}/maps/{version}/activate"
      function_arn   = module.site_function.function_arn
      function_name  = module.site_function.function_name
      authorized     = true
      throttle_rate  = 2
      throttle_burst = 5
    }

    # Alerts (M8, SPEC section 4.3). Every route is JWT-protected; the role and the site are enforced in the
    # function (services/api/src/domain/alerts/route.ts). The actions are throttled like the site activation.
    alerts_list = {
      method         = "GET"
      path           = "/sites/{siteId}/alerts"
      function_arn   = module.alerts_function.function_arn
      function_name  = module.alerts_function.function_name
      authorized     = true
      throttle_rate  = 10
      throttle_burst = 20
    }
    alert_acknowledge = {
      method         = "POST"
      path           = "/sites/{siteId}/alerts/{alertId}/acknowledge"
      function_arn   = module.alerts_function.function_arn
      function_name  = module.alerts_function.function_name
      authorized     = true
      throttle_rate  = 5
      throttle_burst = 10
    }
    alert_resolve = {
      method         = "POST"
      path           = "/sites/{siteId}/alerts/{alertId}/resolve"
      function_arn   = module.alerts_function.function_arn
      function_name  = module.alerts_function.function_name
      authorized     = true
      throttle_rate  = 5
      throttle_burst = 10
    }

    # M9 control and audit routes (SPEC section 4.3, ADR 0062 to ADR 0064). Every route is
    # JWT-protected; the role matrix and the site check are enforced in each function's route.ts. The
    # throttles are per route: commands and the lock are the abusable ones (T54).

    # Control function: commands, the lock, the registry list and demo mode.
    robots_list = {
      method         = "GET"
      path           = "/sites/{siteId}/robots"
      function_arn   = module.control_function.function_arn
      function_name  = module.control_function.function_name
      authorized     = true
      throttle_rate  = 10
      throttle_burst = 20
    }
    robot_lock_get = {
      method         = "GET"
      path           = "/sites/{siteId}/robots/{robotId}/lock"
      function_arn   = module.control_function.function_arn
      function_name  = module.control_function.function_name
      authorized     = true
      throttle_rate  = 10
      throttle_burst = 20
    }
    robot_lock_acquire = {
      method         = "POST"
      path           = "/sites/{siteId}/robots/{robotId}/lock"
      function_arn   = module.control_function.function_arn
      function_name  = module.control_function.function_name
      authorized     = true
      throttle_rate  = 5
      throttle_burst = 10
    }
    robot_lock_release = {
      method         = "POST"
      path           = "/sites/{siteId}/robots/{robotId}/lock/release"
      function_arn   = module.control_function.function_arn
      function_name  = module.control_function.function_name
      authorized     = true
      throttle_rate  = 5
      throttle_burst = 10
    }
    robot_command = {
      method         = "POST"
      path           = "/sites/{siteId}/robots/{robotId}/commands"
      function_arn   = module.control_function.function_arn
      function_name  = module.control_function.function_name
      authorized     = true
      throttle_rate  = 10
      throttle_burst = 20
    }
    demo_get = {
      method         = "GET"
      path           = "/sites/{siteId}/demo"
      function_arn   = module.control_function.function_arn
      function_name  = module.control_function.function_name
      authorized     = true
      throttle_rate  = 5
      throttle_burst = 10
    }
    demo_set = {
      method         = "PUT"
      path           = "/sites/{siteId}/demo"
      function_arn   = module.control_function.function_arn
      function_name  = module.control_function.function_name
      authorized     = true
      throttle_rate  = 2
      throttle_burst = 5
    }

    # Audit function: the read-only paged trail of the site.
    audit_list = {
      method         = "GET"
      path           = "/sites/{siteId}/audit"
      function_arn   = module.audit_function.function_arn
      function_name  = module.audit_function.function_name
      authorized     = true
      throttle_rate  = 5
      throttle_burst = 10
    }

  }
}

# Liveness report of the API. Reads no header, no body and no table: no business policy.
module "health_function" {
  source = "../../modules/lambda-function"

  alarm_topic_arn = module.alarm_topic.topic_arn

  enable_alarms = true

  name        = "mfc-demo-health"
  description = "Public liveness report of the console API, GET /health (synchronous)."
  source_dir  = "${local.api_dist_dir}/health"

  boundary_arn = local.workload_boundary_arn
  role_path    = local.workload_role_path
  policy_json  = null

  timeout     = 5
  memory_size = 256

  maximum_retry_attempts       = 0
  maximum_event_age_in_seconds = 60
  dead_letter_queue_arn        = null

  environment = merge(local.api_function_environment, {
    POWERTOOLS_SERVICE_NAME = "health"
  })
}

# Identity of the signed-in operator, GET /me. The verified claims arrive from the JWT authorizer; the
# function reads no table.
module "me_function" {
  source = "../../modules/lambda-function"

  alarm_topic_arn = module.alarm_topic.topic_arn

  enable_alarms = true

  name        = "mfc-demo-me"
  description = "Identity of the signed-in operator, GET /me (synchronous)."
  source_dir  = "${local.api_dist_dir}/me"

  boundary_arn = local.workload_boundary_arn
  role_path    = local.workload_role_path
  policy_json  = null

  timeout     = 5
  memory_size = 256

  maximum_retry_attempts       = 0
  maximum_event_age_in_seconds = 60
  dead_letter_queue_arn        = null

  environment = merge(local.api_function_environment, {
    POWERTOOLS_SERVICE_NAME = "me"
  })
}

# Issues the single-use WebSocket token to the signed-in operator, POST /ws-token. Same policy as the
# IAM-invoked ws-token function, which stays in realtime.tf.
module "http_ws_token_function" {
  source = "../../modules/lambda-function"

  alarm_topic_arn = module.alarm_topic.topic_arn

  enable_alarms = true

  name        = "mfc-demo-ws-token-http"
  description = "Issues the single-use WebSocket token to the signed-in operator, POST /ws-token (synchronous)."
  source_dir  = "${local.api_dist_dir}/http-ws-token"

  boundary_arn = local.workload_boundary_arn
  role_path    = local.workload_role_path
  policy_json  = jsonencode(local.ws_token_policy)

  timeout     = 5
  memory_size = 256

  maximum_retry_attempts       = 0
  maximum_event_age_in_seconds = 60
  dead_letter_queue_arn        = null

  environment = merge(local.api_function_environment, {
    POWERTOOLS_SERVICE_NAME = "http-ws-token"
    CONNECTIONS_TABLE_NAME  = module.data_tables.connections_table_name
    WS_URL                  = module.websocket_api.ws_url
  })
}
