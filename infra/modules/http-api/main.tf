# HTTP API of the console (M6, ADR 0047). Each route is an AWS_PROXY integration with one Lambda
# function. Routes that carry operator data go through a JWT authorizer on the operator user pool:
# API Gateway rejects a missing, invalid or expired token with a 401 before any function runs. The
# health route is the only one without an authorizer, on purpose.
#
# The stage is $default, so the endpoint has no stage segment. Access logs are JSON and carry no
# query string, no header and no client address: the token of the WebSocket travels in a query string
# on another API, and nothing here should ever hold a credential (THREAT_MODEL R42, R56).

locals {
  # Origins allowed to call the API from a browser. Exact matches only: never a wildcard.
  dev_origin      = "http://localhost:5173"
  allowed_origins = concat([var.console_origin], var.enable_dev_origin ? [local.dev_origin] : [])

  # Only the methods the routes use (extend with the routes, M9+). The list
  # keeps the preflight answer to the methods that exist. PUT is the site configuration (M7).
  allowed_methods = ["GET", "POST", "PUT"]

  # Each line of the access log is one JSON object. The fields are the request id, the route, the
  # status, the latencies and the error messages of the integration and of the authorizer.
  access_log_format = jsonencode({
    requestId               = "$context.requestId"
    requestTime             = "$context.requestTime"
    routeKey                = "$context.routeKey"
    status                  = "$context.status"
    responseLatency         = "$context.responseLatency"
    integrationLatency      = "$context.integrationLatency"
    integrationErrorMessage = "$context.integrationErrorMessage"
    authorizerError         = "$context.authorizer.error"
  })
}

resource "aws_apigatewayv2_api" "this" {
  name          = "${var.name_prefix}-http"
  description   = "Console HTTP API: health, the signed-in identity and the WebSocket token."
  protocol_type = "HTTP"

  # The browser preflight is answered by API Gateway without any authorizer. Credentials are never
  # sent cross-origin: the console keeps its tokens in memory and sends them in the Authorization header.
  cors_configuration {
    allow_origins     = local.allowed_origins
    allow_methods     = local.allowed_methods
    allow_headers     = ["authorization", "content-type", "idempotency-key"]
    allow_credentials = false
    max_age           = 600
  }
}

# Validates the access tokens of the operator user pool. For access tokens, API Gateway checks the
# client_id claim against the audience list, which is the console app client.
resource "aws_apigatewayv2_authorizer" "jwt" {
  api_id           = aws_apigatewayv2_api.this.id
  name             = "${var.name_prefix}-operators"
  authorizer_type  = "JWT"
  identity_sources = ["$request.header.Authorization"]

  jwt_configuration {
    audience = [var.user_pool_client_id]
    issuer   = var.user_pool_endpoint
  }
}

resource "aws_apigatewayv2_integration" "this" {
  for_each = var.routes

  api_id                 = aws_apigatewayv2_api.this.id
  integration_type       = "AWS_PROXY"
  integration_uri        = each.value.function_arn
  integration_method     = "POST"
  payload_format_version = "2.0"
  # Synchronous: API Gateway waits for the function. The default is 5 seconds, equal to the function
  # timeout; a route that waits for a longer function sets its own timeout.
  timeout_milliseconds = coalesce(each.value.timeout_milliseconds, 5000)
}

resource "aws_apigatewayv2_route" "this" {
  #checkov:skip=CKV_AWS_309:The health route is public on purpose: it reports liveness and reads nothing. Every other route is JWT-protected (ADR 0047).
  for_each = var.routes

  api_id             = aws_apigatewayv2_api.this.id
  route_key          = "${each.value.method} ${each.value.path}"
  authorization_type = each.value.authorized ? "JWT" : "NONE"
  authorizer_id      = each.value.authorized ? aws_apigatewayv2_authorizer.jwt.id : null
  target             = "integrations/${aws_apigatewayv2_integration.this[each.key].id}"
}

resource "aws_cloudwatch_log_group" "access" {
  #checkov:skip=CKV_AWS_158:AWS-managed encryption of the log group: a customer-managed key is excluded for cost (SPEC section 11, THREAT_MODEL R2).
  #checkov:skip=CKV_AWS_338:Thirty days of access logs on purpose: SPEC section 8 and the cost policy of section 11.
  name              = "/aws/apigateway/${var.name_prefix}-http"
  retention_in_days = var.log_retention_days
}

resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.this.id
  name        = "$default"
  auto_deploy = true

  default_route_settings {
    throttling_rate_limit  = var.default_throttle_rate
    throttling_burst_limit = var.default_throttle_burst
  }

  # Per-route throttles for the routes that can be abused or that issue credentials (ADR 0047).
  dynamic "route_settings" {
    for_each = { for key, route in var.routes : key => route if route.throttle_rate != null }
    content {
      route_key              = "${route_settings.value.method} ${route_settings.value.path}"
      throttling_rate_limit  = route_settings.value.throttle_rate
      throttling_burst_limit = route_settings.value.throttle_burst
    }
  }

  access_log_settings {
    destination_arn = aws_cloudwatch_log_group.access.arn
    format          = local.access_log_format
  }

  # Auto-deploy publishes the routes that exist when the stage is created.
  depends_on = [aws_apigatewayv2_route.this]
}

# One invocation permission per route, bound to this API and to that method and path only. No other
# principal can invoke the functions through the API.
resource "aws_lambda_permission" "route" {
  for_each = var.routes

  statement_id  = "AllowHttpApi-${each.key}"
  action        = "lambda:InvokeFunction"
  function_name = each.value.function_name
  principal     = "apigateway.amazonaws.com"
  # A path parameter is matched by a wildcard in the source ARN: API Gateway authorises the request
  # with the path it routed (for example /sites/paris-01), never with the template ({siteId}).
  source_arn = "${aws_apigatewayv2_api.this.execution_arn}/*/${each.value.method}${replace(each.value.path, "/\\{[^}]+\\}/", "*")}"
}

# A 5xx from the API means a function failed or a route is misconfigured: the operator is told at
# once, as for the queues. Missing data means no request was served, which is healthy when idle.
resource "aws_cloudwatch_metric_alarm" "api_server_errors" {
  alarm_name          = "${var.name_prefix}-http-5xx"
  alarm_description   = "The console HTTP API answered a 5xx: a function failed or a route is misconfigured."
  namespace           = "AWS/ApiGateway"
  metric_name         = "5xx"
  dimensions          = { ApiId = aws_apigatewayv2_api.this.id, Stage = aws_apigatewayv2_stage.default.name }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [var.alarm_topic_arn]
}
