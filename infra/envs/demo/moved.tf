# Moves the per-function Errors and Throttles alarms from the http-api module into the lambda-function
# module of each function (ADR 0023). The alarm names are unchanged, so a plan shows each alarm as moved,
# never destroyed and created again: the deploy guard refuses plans that delete or replace resources.
# Once every state has applied the move, these blocks can be removed.

moved {
  from = module.http_api.aws_cloudwatch_metric_alarm.function_errors["mfc-demo-health"]
  to   = module.health_function.aws_cloudwatch_metric_alarm.errors[0]
}

moved {
  from = module.http_api.aws_cloudwatch_metric_alarm.function_throttles["mfc-demo-health"]
  to   = module.health_function.aws_cloudwatch_metric_alarm.throttles[0]
}

moved {
  from = module.http_api.aws_cloudwatch_metric_alarm.function_errors["mfc-demo-me"]
  to   = module.me_function.aws_cloudwatch_metric_alarm.errors[0]
}

moved {
  from = module.http_api.aws_cloudwatch_metric_alarm.function_throttles["mfc-demo-me"]
  to   = module.me_function.aws_cloudwatch_metric_alarm.throttles[0]
}

moved {
  from = module.http_api.aws_cloudwatch_metric_alarm.function_errors["mfc-demo-ws-token-http"]
  to   = module.http_ws_token_function.aws_cloudwatch_metric_alarm.errors[0]
}

moved {
  from = module.http_api.aws_cloudwatch_metric_alarm.function_throttles["mfc-demo-ws-token-http"]
  to   = module.http_ws_token_function.aws_cloudwatch_metric_alarm.throttles[0]
}

moved {
  from = module.http_api.aws_cloudwatch_metric_alarm.function_errors["mfc-demo-site"]
  to   = module.site_function.aws_cloudwatch_metric_alarm.errors[0]
}

moved {
  from = module.http_api.aws_cloudwatch_metric_alarm.function_throttles["mfc-demo-site"]
  to   = module.site_function.aws_cloudwatch_metric_alarm.throttles[0]
}

moved {
  from = module.http_api.aws_cloudwatch_metric_alarm.function_errors["mfc-demo-alerts"]
  to   = module.alerts_function.aws_cloudwatch_metric_alarm.errors[0]
}

moved {
  from = module.http_api.aws_cloudwatch_metric_alarm.function_throttles["mfc-demo-alerts"]
  to   = module.alerts_function.aws_cloudwatch_metric_alarm.throttles[0]
}
