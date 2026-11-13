# Identifiers of the HTTP API. The endpoint is not a secret: the console reaches it through the
# runtime configuration that publish-console writes from the root outputs.

output "api_id" {
  type        = string
  description = "ID of the HTTP API."
  value       = aws_apigatewayv2_api.this.id
}

output "api_endpoint" {
  type        = string
  description = "Default HTTPS endpoint of the API, without a stage (the default stage is $default)."
  value       = aws_apigatewayv2_api.this.api_endpoint
}

output "execution_arn" {
  type        = string
  description = "Execution ARN of the API. The invocation permissions of the functions are built from it."
  value       = aws_apigatewayv2_api.this.execution_arn
}

# The reviewed contract of each route as deployed: its key, its authorizer and its integration timeout.
# Exposed for tests only: a root run cannot reach the resources of a child module, so control.tftest.hcl reads
# the routes of api.tf through this output. No runtime component reads it.
output "route_contract" {
  type = map(object({
    route_key            = string
    authorization_type   = string
    function_name        = string
    timeout_milliseconds = number
  }))
  description = "Route key, authorization type, function name and integration timeout of each route, keyed like the routes variable."
  value = {
    for key, route in var.routes : key => {
      route_key            = aws_apigatewayv2_route.this[key].route_key
      authorization_type   = aws_apigatewayv2_route.this[key].authorization_type
      function_name        = route.function_name
      timeout_milliseconds = aws_apigatewayv2_integration.this[key].timeout_milliseconds
    }
  }
}
