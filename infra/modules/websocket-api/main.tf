# WebSocket API of the live console (SPEC section 8, ADR 0041). Every route is an AWS_PROXY
# integration with a Lambda function. The $connect route has no API Gateway authorizer on purpose:
# the single-use token is checked by the ws-connect function, so that one attempt costs one
# invocation and no authorizer cache (THREAT_MODEL R40). Access logs and execution logs stay off:
# the query string of $connect carries the token, and no log format here omits it (M10 revisits it).

locals {
  # Management endpoint of the stage. The regex of the telemetry function accepts exactly this form.
  management_endpoint = "https://${aws_apigatewayv2_api.this.id}.execute-api.${var.region}.amazonaws.com/${var.stage_name}"
}

resource "aws_apigatewayv2_api" "this" {
  name                       = "${var.name_prefix}-live"
  description                = "Live console: WebSocket connections, state snapshots and deltas."
  protocol_type              = "WEBSOCKET"
  route_selection_expression = "$request.body.type"
}

resource "aws_apigatewayv2_integration" "connect" {
  api_id             = aws_apigatewayv2_api.this.id
  integration_type   = "AWS_PROXY"
  integration_uri    = "arn:aws:apigateway:${var.region}:lambda:path/2015-03-31/functions/${var.routes.connect.function_arn}/invocations"
  integration_method = "POST"
}

resource "aws_apigatewayv2_integration" "disconnect" {
  api_id             = aws_apigatewayv2_api.this.id
  integration_type   = "AWS_PROXY"
  integration_uri    = "arn:aws:apigateway:${var.region}:lambda:path/2015-03-31/functions/${var.routes.disconnect.function_arn}/invocations"
  integration_method = "POST"
}

resource "aws_apigatewayv2_integration" "default" {
  api_id             = aws_apigatewayv2_api.this.id
  integration_type   = "AWS_PROXY"
  integration_uri    = "arn:aws:apigateway:${var.region}:lambda:path/2015-03-31/functions/${var.routes.default.function_arn}/invocations"
  integration_method = "POST"
}

resource "aws_apigatewayv2_route" "connect" {
  #checkov:skip=CKV_AWS_309:The token is checked by the ws-connect function (single use, site bound, origin checked), not by an API Gateway authorizer: a second check would be cached and add a second function (ADR 0041, THREAT_MODEL R40).
  api_id             = aws_apigatewayv2_api.this.id
  route_key          = "$connect"
  authorization_type = "NONE"
  target             = "integrations/${aws_apigatewayv2_integration.connect.id}"
}

# $disconnect and $default carry no API Gateway authorizer either: API Gateway only routes them for a
# connection that $connect already admitted, and ws-message checks the connection record itself.
resource "aws_apigatewayv2_route" "disconnect" {
  #checkov:skip=CKV_AWS_309:Connection cleanup is reached only after $connect admitted the connection; no authorizer adds a check here (ADR 0041).
  api_id             = aws_apigatewayv2_api.this.id
  route_key          = "$disconnect"
  authorization_type = "NONE"
  target             = "integrations/${aws_apigatewayv2_integration.disconnect.id}"
}

resource "aws_apigatewayv2_route" "default" {
  #checkov:skip=CKV_AWS_309:Client messages reach this route only over a connection that $connect admitted; ws-message checks the connection record and the session on each message (ADR 0041).
  api_id             = aws_apigatewayv2_api.this.id
  route_key          = "$default"
  authorization_type = "NONE"
  target             = "integrations/${aws_apigatewayv2_integration.default.id}"
}

resource "aws_apigatewayv2_stage" "this" {
  #checkov:skip=CKV2_AWS_51:Client certificate authentication is a REST API feature; WebSocket clients authenticate with the single-use token checked by ws-connect (ADR 0041).
  #checkov:skip=CKV_AWS_76:No access logging on purpose: the $connect query string carries the single-use token (THREAT_MODEL T25); revisit in M10 with a format that omits the request URI.
  api_id      = aws_apigatewayv2_api.this.id
  name        = var.stage_name
  auto_deploy = true

  default_route_settings {
    throttling_rate_limit    = var.throttle_rate
    throttling_burst_limit   = var.throttle_burst
    data_trace_enabled       = false
    logging_level            = "OFF"
    detailed_metrics_enabled = false
  }

  route_settings {
    route_key                = "$connect"
    throttling_rate_limit    = var.connect_rate
    throttling_burst_limit   = var.connect_burst
    data_trace_enabled       = false
    logging_level            = "OFF"
    detailed_metrics_enabled = false
  }

  # Auto-deploy publishes the routes that exist when the stage is created.
  depends_on = [
    aws_apigatewayv2_route.connect,
    aws_apigatewayv2_route.disconnect,
    aws_apigatewayv2_route.default,
  ]
}

# One invocation permission per route, bound to this API and any stage of it. No other principal
# can invoke the three functions through the API.
resource "aws_lambda_permission" "connect" {
  statement_id  = "AllowWebSocketConnect"
  action        = "lambda:InvokeFunction"
  function_name = var.routes.connect.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.this.execution_arn}/*/$connect"
}

resource "aws_lambda_permission" "disconnect" {
  statement_id  = "AllowWebSocketDisconnect"
  action        = "lambda:InvokeFunction"
  function_name = var.routes.disconnect.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.this.execution_arn}/*/$disconnect"
}

resource "aws_lambda_permission" "default" {
  statement_id  = "AllowWebSocketMessage"
  action        = "lambda:InvokeFunction"
  function_name = var.routes.default.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.this.execution_arn}/*/$default"
}
