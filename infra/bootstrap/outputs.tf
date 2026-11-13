# Values the demo stack and the GitHub workflows need. None of them is secret: ARNs and names only.

output "state_bucket_name" {
  type        = string
  description = "Name of the Terraform state bucket; the demo stack backend points here."
  value       = aws_s3_bucket.state.bucket
}

output "plan_role_arn" {
  type        = string
  description = "ARN of the read-only CI role assumed by the pull request plan workflow."
  value       = aws_iam_role.gha_plan.arn
}

output "deploy_role_arn" {
  type        = string
  description = "ARN of the CI role assumed by the deploy workflow, only for refs/heads/main."
  value       = aws_iam_role.gha_deploy.arn
}

output "e2e_role_arn" {
  type        = string
  description = "ARN of the CI role assumed by the deployed-URL e2e job, only for refs/heads/main; set as the AWS_E2E_ROLE_ARN repository variable."
  value       = aws_iam_role.gha_e2e.arn
}

output "workload_boundary_arn" {
  type        = string
  description = "ARN of the permission boundary that every workload role must carry."
  value       = aws_iam_policy.workload_boundary.arn
}

output "workload_role_path" {
  type        = string
  description = "IAM path of the workload roles created by the demo stack; the deploy policies match this path."
  value       = local.workload_path
}
