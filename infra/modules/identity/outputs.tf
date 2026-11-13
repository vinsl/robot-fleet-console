# Identifiers of the identity stack. The console reads them from the runtime configuration that
# publish-console writes from the root outputs; none of them is a secret.

output "user_pool_id" {
  type        = string
  description = "ID of the Cognito user pool of the operators."
  value       = aws_cognito_user_pool.this.id
}

output "user_pool_arn" {
  type        = string
  description = "ARN of the Cognito user pool. Reserved for the user administration policies of the bootstrap script."
  value       = aws_cognito_user_pool.this.arn
}

output "user_pool_client_id" {
  type        = string
  description = "ID of the public app client of the console (SRP and refresh only, no secret)."
  value       = aws_cognito_user_pool_client.console.id
}

output "user_pool_endpoint" {
  type        = string
  description = "Issuer URL of the user pool. The HTTP API JWT authorizer validates the tokens against it."
  value       = "https://${aws_cognito_user_pool.this.endpoint}"
}

output "identity_pool_id" {
  type        = string
  description = "ID of the identity pool that gives the signed-in console temporary AWS credentials."
  value       = aws_cognito_identity_pool.this.id
}
