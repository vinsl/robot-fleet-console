# Customer-managed policies of the CI roles and the workload permission boundary.
#
# Policy documents are built with jsonencode() in locals so that they are readable as data and
# checkable by the tests. Every Action is a list, so the tests can read statements uniformly.
# Allow statements never use the global "*" action; service-scoped wildcards (for example
# "logs:*") are limited to the resources listed next to them.
#
# Each managed policy must stay under the 6144-character IAM limit (checked in tests/iam.tftest.hcl).
# A deploy policy that grows past it should be split by service, not compressed.
#
# A Deny that carves a resource out of a broad Allow sits in the same policy as that Allow, so the
# two are read together (for example the trail bucket in mfc-demo-deploy-data).
#
# ARNs are written out in full with var.region and the caller's account id, so nothing here
# hard-codes either value.

data "aws_caller_identity" "current" {}

locals {
  account_id    = data.aws_caller_identity.current.account_id
  workload_path = "/mfc-demo/"

  workload_boundary_arn = aws_iam_policy.workload_boundary.arn
  alarm_email_param_arn = "arn:aws:ssm:${var.region}:${local.account_id}:parameter/mfc-demo/alarm-email"

  # The audit trail and its bucket are declared in infra/modules/audit-trail (ADR 0022) as
  # <prefix>-trail and <prefix>-trail-<suffix>; these two values must match that module. The bucket
  # pattern with a trailing * also matches the objects: the /* entry keeps that visible.
  audit_trail_arn   = "arn:aws:cloudtrail:${var.region}:${local.account_id}:trail/mfc-demo-trail"
  trail_bucket_arns = ["arn:aws:s3:::mfc-demo-trail-*", "arn:aws:s3:::mfc-demo-trail-*/*"]

  # Plan guard: the plan role is assumed by code from pull requests, so it must not read data
  # (records, video, logs, users, secrets) it does not need to compute a plan. ReadOnlyAccess
  # is granted by the role; this policy takes back the exceptions with explicit Denies, which
  # win over any Allow.
  plan_guard_policy = {
    Version = "2012-10-17"
    Statement = [
      {
        # Terraform reads its own state (envs/demo and bootstrap) and nothing else in S3.
        Sid         = "DenyObjectReadsOutsideTerraformState"
        Effect      = "Deny"
        Action      = ["s3:GetObject*"]
        NotResource = ["${local.state_bucket_arn}/envs/demo/*", "${local.state_bucket_arn}/bootstrap/*"]
      },
      {
        Sid      = "DenyTableReads"
        Effect   = "Deny"
        Action   = ["dynamodb:GetItem", "dynamodb:BatchGetItem", "dynamodb:Query", "dynamodb:Scan", "dynamodb:GetRecords"]
        Resource = ["*"]
      },
      {
        # Video of the robots is the most sensitive data of the demo (threat T8).
        Sid    = "DenyVideoMedia"
        Effect = "Deny"
        Action = [
          "kinesisvideo:GetMedia*",
          "kinesisvideo:GetClip",
          "kinesisvideo:GetHLS*",
          "kinesisvideo:GetDASH*",
          "kinesisvideo:GetImages",
          "kinesisvideo:ConnectAs*",
        ]
        Resource = ["*"]
      },
      {
        Sid      = "DenyLogContents"
        Effect   = "Deny"
        Action   = ["logs:GetLogEvents", "logs:FilterLogEvents", "logs:StartQuery", "logs:StartLiveTail"]
        Resource = ["*"]
      },
      {
        Sid      = "DenyUserDirectory"
        Effect   = "Deny"
        Action   = ["cognito-idp:ListUsers", "cognito-idp:ListUsersInGroup", "cognito-idp:AdminGetUser"]
        Resource = ["*"]
      },
      {
        Sid      = "DenyQueueMessages"
        Effect   = "Deny"
        Action   = ["sqs:ReceiveMessage"]
        Resource = ["*"]
      },
      {
        Sid      = "DenySecrets"
        Effect   = "Deny"
        Action   = ["secretsmanager:GetSecretValue"]
        Resource = ["*"]
      },
      {
        # The alarm e-mail is the one parameter the plan needs: the stack reads it at plan time.
        Sid         = "DenyParametersExceptAlarmEmail"
        Effect      = "Deny"
        Action      = ["ssm:GetParameter*"]
        NotResource = [local.alarm_email_param_arn]
      },
      {
        Sid      = "DenyRetainedMessages"
        Effect   = "Deny"
        Action   = ["iot:GetRetainedMessage", "iot:ListRetainedMessages"]
        Resource = ["*"]
      },
      {
        # Read paths to data the plan never needs: PartiQL queries, X-Ray traces, device shadows,
        # log query results and the CloudTrail event history.
        Sid    = "DenyTelemetryTracesAndAuditReads"
        Effect = "Deny"
        Action = [
          "dynamodb:PartiQLSelect",
          "xray:BatchGetTraces",
          "xray:GetTraceSummaries",
          "xray:GetTraceGraph",
          "iot:GetThingShadow",
          "iot:ListNamedShadowsForThing",
          "logs:DescribeQueries",
          "logs:GetQueryResults",
          "logs:GetLogRecord",
          "logs:GetLogGroupFields",
          "cloudtrail:LookupEvents",
        ]
        Resource = ["*"]
      },
    ]
  }

  # Deploy core: Terraform state for the demo stack, the account-level services the stack needs,
  # and IAM restricted to the /mfc-demo/ path and to the workload boundary.
  deploy_core_policy = {
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "TerraformStateOfDemoStack"
        Effect = "Allow"
        Action = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
        Resource = [
          "${local.state_bucket_arn}/envs/demo/terraform.tfstate",
          "${local.state_bucket_arn}/envs/demo/terraform.tfstate.tflock",
        ]
      },
      {
        Sid      = "TerraformStateBucketList"
        Effect   = "Allow"
        Action   = ["s3:ListBucket"]
        Resource = [local.state_bucket_arn]
      },
      {
        # Restarting the logging of the demo trail and managing its tags only. Creating, updating and
        # deleting a trail are denied in DenyAuditTrailChanges below (ADR 0024).
        Sid      = "CloudTrailDemoTrail"
        Effect   = "Allow"
        Action   = ["cloudtrail:StartLogging", "cloudtrail:AddTags", "cloudtrail:RemoveTags"]
        Resource = [local.audit_trail_arn]
      },
      {
        Sid      = "SnsDemoTopics"
        Effect   = "Allow"
        Action   = ["sns:*"]
        Resource = ["arn:aws:sns:${var.region}:${local.account_id}:mfc-demo-*"]
      },
      {
        Sid    = "BudgetsOfDemoStack"
        Effect = "Allow"
        Action = ["budgets:ModifyBudget", "budgets:ViewBudget", "budgets:TagResource", "budgets:UntagResource"]
        Resource = [
          for name in var.budget_names : "arn:aws:budgets::${local.account_id}:budget/${name}"
        ]
      },
      {
        Sid    = "SsmDemoParameters"
        Effect = "Allow"
        Action = [
          "ssm:PutParameter",
          "ssm:DeleteParameter",
          "ssm:AddTagsToResource",
          "ssm:RemoveTagsFromResource",
        ]
        Resource = ["arn:aws:ssm:${var.region}:${local.account_id}:parameter/mfc-demo/*"]
      },
      {
        Sid    = "CloudWatchDemoAlarms"
        Effect = "Allow"
        Action = [
          "cloudwatch:PutMetricAlarm",
          "cloudwatch:DeleteAlarms",
          "cloudwatch:TagResource",
          "cloudwatch:UntagResource",
        ]
        Resource = ["arn:aws:cloudwatch:${var.region}:${local.account_id}:alarm:mfc-demo-*"]
      },
      {
        # Log groups are listed with and without the :* suffix: the suffix matches log streams,
        # which some APIs address as separate resources.
        Sid    = "LogGroupsOfDemoStack"
        Effect = "Allow"
        Action = ["logs:*"]
        Resource = [
          "arn:aws:logs:${var.region}:${local.account_id}:log-group:/aws/lambda/mfc-demo-*",
          "arn:aws:logs:${var.region}:${local.account_id}:log-group:/aws/lambda/mfc-demo-*:*",
          "arn:aws:logs:${var.region}:${local.account_id}:log-group:/aws/apigateway/mfc-demo-*",
          "arn:aws:logs:${var.region}:${local.account_id}:log-group:/aws/apigateway/mfc-demo-*:*",
          "arn:aws:logs:${var.region}:${local.account_id}:log-group:/mfc-demo/*",
          "arn:aws:logs:${var.region}:${local.account_id}:log-group:/mfc-demo/*:*",
          # The name of the IoT V2 logging group is fixed by AWS, so it carries no demo prefix (ADR 0020).
          "arn:aws:logs:${var.region}:${local.account_id}:log-group:AWSIotLogsV2",
          "arn:aws:logs:${var.region}:${local.account_id}:log-group:AWSIotLogsV2:*",
        ]
      },
      {
        # API Gateway access logs are delivered through CloudWatch Logs delivery, whose actions do not support
        # resource-level permissions. Without them CreateStage fails with "Insufficient permissions to enable
        # logging" (JOURNAL, 2026-11-03). The destination is still limited to the demo log groups by the statement above.
        Sid    = "LogDeliveryForApiAccessLogs"
        Effect = "Allow"
        Action = [
          "logs:CreateLogDelivery",
          "logs:GetLogDelivery",
          "logs:UpdateLogDelivery",
          "logs:DeleteLogDelivery",
          "logs:ListLogDeliveries",
          "logs:DescribeResourcePolicies",
          "logs:DescribeLogGroups",
        ]
        Resource = ["*"]
      },
      {
        Sid    = "AccessAnalyzerDemo"
        Effect = "Allow"
        # DeleteAnalyzer is denied in DenyAnalyzerDeletion below.
        Action   = ["access-analyzer:CreateAnalyzer", "access-analyzer:TagResource"]
        Resource = ["arn:aws:access-analyzer:${var.region}:${local.account_id}:analyzer/mfc-demo-*"]
      },
      {
        # Roles created here must carry the workload boundary: the condition is what stops the
        # deploy role from creating a role with more rights than the boundary allows.
        Sid      = "IamCreateWorkloadRolesWithBoundary"
        Effect   = "Allow"
        Action   = ["iam:CreateRole", "iam:PutRolePermissionsBoundary"]
        Resource = ["arn:aws:iam::${local.account_id}:role${local.workload_path}*"]
        Condition = {
          StringEquals = { "iam:PermissionsBoundary" = local.workload_boundary_arn }
        }
      },
      {
        # The boundary caps every role of the path, so these actions need no condition of their
        # own. The condition key iam:PermissionsBoundary is not part of these requests and would
        # make the Allow never match. DeleteRolePermissionsBoundary is denied below.
        Sid    = "IamAttachPoliciesToWorkloadRoles"
        Effect = "Allow"
        Action = [
          "iam:PutRolePolicy",
          "iam:DeleteRolePolicy",
          "iam:AttachRolePolicy",
          "iam:DetachRolePolicy",
        ]
        Resource = ["arn:aws:iam::${local.account_id}:role${local.workload_path}*"]
      },
      {
        Sid      = "IamManageWorkloadRoles"
        Effect   = "Allow"
        Action   = ["iam:DeleteRole", "iam:TagRole", "iam:UntagRole", "iam:UpdateRole", "iam:UpdateAssumeRolePolicy"]
        Resource = ["arn:aws:iam::${local.account_id}:role${local.workload_path}*"]
      },
      {
        Sid    = "IamManageWorkloadPolicies"
        Effect = "Allow"
        Action = [
          "iam:CreatePolicy",
          "iam:CreatePolicyVersion",
          "iam:DeletePolicy",
          "iam:DeletePolicyVersion",
          "iam:TagPolicy",
        ]
        Resource = ["arn:aws:iam::${local.account_id}:policy${local.workload_path}*"]
      },
      {
        # PassRole is limited to the services that run the workload roles, so a role of the path
        # cannot be handed to an unrelated service.
        Sid      = "IamPassWorkloadRoles"
        Effect   = "Allow"
        Action   = ["iam:PassRole"]
        Resource = ["arn:aws:iam::${local.account_id}:role${local.workload_path}*"]
        Condition = {
          StringEquals = {
            "iam:PassedToService" = [
              "lambda.amazonaws.com",
              "apigateway.amazonaws.com",
              "iot.amazonaws.com",
              "credentials.iot.amazonaws.com",
            ]
          }
        }
      },
      {
        # Cognito (CreateGroup, SetIdentityPoolRoles) does not send iam:PassedToService, so a
        # conditioned statement can never match. The path restriction on the role ARN is the
        # remaining guard: only workload roles can be attached to groups and identity pools.
        Sid      = "IamPassWorkloadRolesToCognito"
        Effect   = "Allow"
        Action   = ["iam:PassRole"]
        Resource = ["arn:aws:iam::${local.account_id}:role${local.workload_path}*"]
      },
      {
        # The CI roles themselves are off limits: only reads are allowed on them. NotAction
        # keeps this a complete deny of every write, including the ones AWS adds later.
        Sid       = "DenyIamWritesOnCiResources"
        Effect    = "Deny"
        NotAction = ["iam:Get*", "iam:List*"]
        Resource = [
          "arn:aws:iam::${local.account_id}:role${local.ci_path}*",
          "arn:aws:iam::${local.account_id}:policy${local.ci_path}*",
          "arn:aws:iam::${local.account_id}:oidc-provider/${local.github_oidc_host}",
        ]
      },
      {
        # Removing the boundary from a role would lift the cap on its rights.
        Sid      = "DenyDeleteRolePermissionsBoundary"
        Effect   = "Deny"
        Action   = ["iam:DeleteRolePermissionsBoundary"]
        Resource = ["*"]
      },
      {
        # The bootstrap state is written by the owner's SSO session only.
        Sid      = "DenyBootstrapStateObjects"
        Effect   = "Deny"
        Action   = ["s3:*Object*"]
        Resource = ["${local.state_bucket_arn}/bootstrap/*"]
      },
      {
        # Denied on its own statement so that no Allow of this policy, present or added later, can
        # stop the audit trail from CI (SEC-LOG-1).
        Sid      = "DenyStopCloudTrail"
        Effect   = "Deny"
        Action   = ["cloudtrail:StopLogging"]
        Resource = ["*"]
      },
      {
        # The audit trail is created, configured and deleted from the owner's SSO session, never by CI.
        # CreateTrail is denied too: CI could otherwise add a second trail (a billed second copy of the
        # management events) or, once the demo trail is gone, recreate it with delivery to a bucket of
        # another account; CreateTrail has no condition key on the bucket. Updates from CI are refused:
        # this is the cost of keeping CI unable to weaken the audit trail (SEC-LOG-1, ADR 0024).
        Sid      = "DenyAuditTrailChanges"
        Effect   = "Deny"
        Action   = ["cloudtrail:CreateTrail", "cloudtrail:DeleteTrail", "cloudtrail:UpdateTrail", "cloudtrail:PutEventSelectors"]
        Resource = ["*"]
      },
      {
        # Deleting the analyzer removes the external-access findings of the account.
        Sid      = "DenyAnalyzerDeletion"
        Effect   = "Deny"
        Action   = ["access-analyzer:DeleteAnalyzer"]
        Resource = ["*"]
      },
      {
        # A deleted state version is lost history, and the previous state is the only recovery from a
        # bad apply. CI writes new versions only (THREAT_MODEL R10).
        Sid      = "DenyStateObjectVersionDeletion"
        Effect   = "Deny"
        Action   = ["s3:DeleteObjectVersion"]
        Resource = ["${local.state_bucket_arn}/*"]
      },
    ]
  }

  # Deploy data: S3 buckets, DynamoDB tables and SQS queues named with the demo prefix. The trail
  # bucket matches the prefix too, so it is carved out here: CI only reads and tags it (ADR 0024).
  deploy_data_policy = {
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "S3DemoBuckets"
        Effect = "Allow"
        Action = ["s3:*"]
        Resource = [
          "arn:aws:s3:::mfc-demo-*",
          "arn:aws:s3:::mfc-demo-*/*",
        ]
      },
      {
        # The state bucket is changed by the owner only. S3DemoBuckets grants s3:* on every mfc-demo-*
        # bucket, and that pattern matches the state bucket. NotAction denies every bucket-level action
        # except the reads, including the administration actions AWS adds later. The Deny names the
        # bucket ARN only: object actions are on bucket/* and stay governed by the Allow statements.
        Sid       = "DenyStateBucketAdministration"
        Effect    = "Deny"
        NotAction = ["s3:Get*", "s3:List*"]
        Resource  = [local.state_bucket_arn]
      },
      {
        # The trail bucket holds the audit evidence (SEC-LOG-1). CI keeps the reads that a Terraform
        # refresh needs (the bucket and each of its settings) and the tag actions: the AWS provider
        # tags buckets with the S3 Control TagResource and UntagResource APIs and falls back to
        # PutBucketTagging. Every other action is refused, including the ones AWS adds later: creating,
        # configuring, writing to or emptying the bucket happens in the owner's SSO session.
        Sid       = "DenyTrailBucketChangesExceptTags"
        Effect    = "Deny"
        NotAction = ["s3:Get*", "s3:List*", "s3:PutBucketTagging", "s3:TagResource", "s3:UntagResource"]
        Resource  = local.trail_bucket_arns
      },
      {
        # Account-level Block Public Access is set by the bootstrap (account.tf). No Allow grants this
        # action today: it takes Resource "*", and every S3 Allow is scoped to bucket ARNs. The Deny
        # keeps it that way if one is added. The same action authorises the delete of the setting.
        Sid      = "DenyAccountPublicAccessBlockChanges"
        Effect   = "Deny"
        Action   = ["s3:PutAccountPublicAccessBlock"]
        Resource = ["*"]
      },
      {
        Sid    = "DynamoDbDemoTables"
        Effect = "Allow"
        Action = ["dynamodb:*"]
        Resource = [
          "arn:aws:dynamodb:${var.region}:${local.account_id}:table/mfc-demo-*",
          "arn:aws:dynamodb:${var.region}:${local.account_id}:table/mfc-demo-*/index/*",
          "arn:aws:dynamodb:${var.region}:${local.account_id}:table/mfc-demo-*/stream/*",
        ]
      },
      {
        Sid      = "SqsDemoQueues"
        Effect   = "Allow"
        Action   = ["sqs:*"]
        Resource = ["arn:aws:sqs:${var.region}:${local.account_id}:mfc-demo-*"]
      },
    ]
  }

  # Deploy compute: Lambda functions and layers, and the API Gateway paths the stack manages.
  deploy_compute_policy = {
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "LambdaDemoFunctionsAndLayers"
        Effect = "Allow"
        Action = ["lambda:*"]
        Resource = [
          "arn:aws:lambda:${var.region}:${local.account_id}:function:mfc-demo-*",
          "arn:aws:lambda:${var.region}:${local.account_id}:layer:mfc-demo-*",
        ]
      },
      {
        # Event source mappings have no ARN of their own: they are bound to the function they
        # wire through the lambda:FunctionArn condition.
        Sid       = "LambdaEventSourceMappingsOfDemoFunctions"
        Effect    = "Allow"
        Action    = ["lambda:*EventSourceMapping"]
        Resource  = ["*"]
        Condition = { ArnLike = { "lambda:FunctionArn" = "arn:aws:lambda:${var.region}:${local.account_id}:function:mfc-demo-*" } }
      },
      {
        # Terraform tags a mapping when it creates it; the tag actions address the mapping ARN,
        # which the FunctionArn condition above cannot match.
        Sid      = "LambdaEventSourceMappingTags"
        Effect   = "Allow"
        Action   = ["lambda:TagResource", "lambda:UntagResource", "lambda:ListTags"]
        Resource = ["arn:aws:lambda:${var.region}:${local.account_id}:event-source-mapping:*"]
      },
      {
        Sid    = "ApiGatewayManagementPaths"
        Effect = "Allow"
        Action = [
          "apigateway:GET",
          "apigateway:POST",
          "apigateway:PUT",
          "apigateway:PATCH",
          "apigateway:DELETE",
          "apigateway:TagResource",
          "apigateway:UntagResource",
        ]
        Resource = [
          "arn:aws:apigateway:${var.region}::/apis",
          "arn:aws:apigateway:${var.region}::/apis/*",
          "arn:aws:apigateway:${var.region}::/tags/*",
          "arn:aws:apigateway:${var.region}::/account",
        ]
      },
    ]
  }

  # Deploy edge: CloudFront in front of the console, Cognito user pool and identity pool.
  deploy_edge_policy = {
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "CloudFrontDemoDistribution"
        Effect = "Allow"
        Action = ["cloudfront:*"]
        Resource = [
          "arn:aws:cloudfront::${local.account_id}:distribution/*",
          "arn:aws:cloudfront::${local.account_id}:origin-access-control/*",
          "arn:aws:cloudfront::${local.account_id}:response-headers-policy/*",
          "arn:aws:cloudfront::${local.account_id}:cache-policy/*",
          "arn:aws:cloudfront::${local.account_id}:function/mfc-demo-*",
        ]
      },
      {
        # Existing user pools are changed only when they carry the project tag, so the stack
        # cannot modify a pool it did not create.
        Sid       = "CognitoUserPoolsOfProject"
        Effect    = "Allow"
        Action    = ["cognito-idp:*"]
        Resource  = ["arn:aws:cognito-idp:${var.region}:${local.account_id}:userpool/*"]
        Condition = { StringEquals = { "aws:ResourceTag/project" = "mfc" } }
      },
      {
        # Creation has no existing resource to check, so the tag must be set in the request.
        Sid       = "CognitoUserPoolCreateTagged"
        Effect    = "Allow"
        Action    = ["cognito-idp:CreateUserPool"]
        Resource  = ["*"]
        Condition = { StringEquals = { "aws:RequestTag/project" = "mfc" } }
      },
      {
        Sid      = "CognitoIdentityPools"
        Effect   = "Allow"
        Action   = ["cognito-identity:*"]
        Resource = ["arn:aws:cognito-identity:${var.region}:${local.account_id}:identitypool/*"]
      },
    ]
  }

  # Deploy IoT: topic rules, policies, role aliases and thing groups of the demo, plus the
  # Kinesis Video channels used by the robot video.
  deploy_iot_policy = {
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "IotDemoResources"
        Effect = "Allow"
        Action = ["iot:*"]
        Resource = [
          # The IAM resource type of a topic rule is "rule". "topicrule" matches no resource, so CI could
          # not create any rule before this fix (ADR 0020, amendment of 2026-11-01).
          "arn:aws:iot:${var.region}:${local.account_id}:rule/mfc_demo_*",
          "arn:aws:iot:${var.region}:${local.account_id}:policy/mfc-demo-*",
          "arn:aws:iot:${var.region}:${local.account_id}:rolealias/mfc-demo-*",
          "arn:aws:iot:${var.region}:${local.account_id}:thinggroup/mfc-demo-*",
        ]
      },
      {
        # Logging options are account-wide and have no resource to scope to.
        Sid      = "IotLoggingOptions"
        Effect   = "Allow"
        Action   = ["iot:SetV2LoggingOptions"]
        Resource = ["*"]
      },
      {
        Sid      = "KinesisVideoDemoChannels"
        Effect   = "Allow"
        Action   = ["kinesisvideo:*"]
        Resource = ["arn:aws:kinesisvideo:${var.region}:${local.account_id}:channel/mfc-demo-*/*"]
      },
    ]
  }

  # E2E: the deployed-URL test creates one ephemeral Operator and one robot, then deletes both. The
  # group is not a condition key in IAM, so the role could add that user to any group; the script
  # hard-codes Operator and the user lives minutes (threat T-E1). The robots function is named
  # exactly, not by prefix, so no other function of the demo can be invoked. The telemetry consumer
  # is the event source mapping of the ingest function only: the e2e run enables it for its robot
  # and restores it afterwards (scripts/demo-consumer.sh), and nothing else in the mapping is granted.
  e2e_policy = {
    Version = "2012-10-17"
    Statement = [
      {
        # ListUsers is for the janitor that deletes users left by a crashed run; the script never
        # prints what it reads.
        Sid    = "CognitoEphemeralOperator"
        Effect = "Allow"
        Action = [
          "cognito-idp:AdminCreateUser",
          "cognito-idp:AdminAddUserToGroup",
          "cognito-idp:AdminDeleteUser",
          "cognito-idp:ListUsers",
        ]
        Resource  = ["arn:aws:cognito-idp:${var.region}:${local.account_id}:userpool/*"]
        Condition = { StringEquals = { "aws:ResourceTag/project" = "mfc" } }
      },
      {
        Sid      = "InvokeRobotsFunction"
        Effect   = "Allow"
        Action   = ["lambda:InvokeFunction"]
        Resource = ["arn:aws:lambda:${var.region}:${local.account_id}:function:mfc-demo-robots"]
      },
      {
        # IAM has no resource for ListEventSourceMappings: it is authorised on *. The action only
        # lists the mapping ids of the account, so it cannot change anything; the next statement
        # is the one that limits the changes. A condition would not match this action, so it cannot
        # share that statement.
        Sid      = "ListEventSourceMappings"
        Effect   = "Allow"
        Action   = ["lambda:ListEventSourceMappings"]
        Resource = ["*"]
      },
      {
        # Reading a mapping grants nothing and cannot be bound to one function here: the condition key
        # is documented for the write actions, and a read that the key did not match would only fail
        # the run. The read is therefore kept apart, so that the write below is the only scoped grant.
        Sid      = "GetEventSourceMappings"
        Effect   = "Allow"
        Action   = ["lambda:GetEventSourceMapping"]
        Resource = ["arn:aws:lambda:${var.region}:${local.account_id}:event-source-mapping:*"]
      },
      {
        # The write addresses the mapping by its UUID, so the function ARN in the condition is what binds it
        # to the telemetry consumer. A missing key fails closed: the update is then denied, never widened.
        Sid      = "UpdateIngestConsumerEventSourceMapping"
        Effect   = "Allow"
        Action   = ["lambda:UpdateEventSourceMapping"]
        Resource = ["arn:aws:lambda:${var.region}:${local.account_id}:event-source-mapping:*"]
        Condition = {
          ArnEquals = {
            "lambda:FunctionArn" = "arn:aws:lambda:${var.region}:${local.account_id}:function:mfc-demo-ingest-telemetry"
          }
        }
      },
    ]
  }

  # Workload boundary: the most a workload role can ever do. A role's own policies can grant
  # less, never more. The explicit Denies remove the state bucket, the trail bucket, IAM and role
  # assumption.
  workload_boundary_policy = {
    Version = "2012-10-17"
    Statement = [
      {
        # X-Ray and CloudWatch metrics have no resource-level ARN for these actions.
        Sid      = "WorkloadTracingAndMetrics"
        Effect   = "Allow"
        Action   = ["xray:*", "cloudwatch:PutMetricData"]
        Resource = ["*"]
      },
      {
        # API ids are generated by API Gateway, so no prefix can scope them: the account and the
        # region are the narrowest scope available for the WebSocket connections of the console.
        Sid      = "WorkloadWebSocketConnections"
        Effect   = "Allow"
        Action   = ["execute-api:ManageConnections"]
        Resource = ["arn:aws:execute-api:${var.region}:${local.account_id}:*"]
      },
      {
        Sid      = "WorkloadInvokeDemoFunctions"
        Effect   = "Allow"
        Action   = ["lambda:InvokeFunction"]
        Resource = ["arn:aws:lambda:${var.region}:${local.account_id}:function:mfc-demo-*"]
      },
      {
        Sid    = "WorkloadLogsOfDemo"
        Effect = "Allow"
        Action = ["logs:*"]
        Resource = [
          "arn:aws:logs:${var.region}:${local.account_id}:log-group:/aws/lambda/mfc-demo-*",
          "arn:aws:logs:${var.region}:${local.account_id}:log-group:/aws/lambda/mfc-demo-*:*",
          "arn:aws:logs:${var.region}:${local.account_id}:log-group:/aws/apigateway/mfc-demo-*",
          "arn:aws:logs:${var.region}:${local.account_id}:log-group:/aws/apigateway/mfc-demo-*:*",
          "arn:aws:logs:${var.region}:${local.account_id}:log-group:/mfc-demo/*",
          "arn:aws:logs:${var.region}:${local.account_id}:log-group:/mfc-demo/*:*",
          # The IoT V2 logging group has a fixed name chosen by AWS, so it carries no demo prefix (ADR 0020).
          "arn:aws:logs:${var.region}:${local.account_id}:log-group:AWSIotLogsV2",
          "arn:aws:logs:${var.region}:${local.account_id}:log-group:AWSIotLogsV2:*",
        ]
      },
      {
        # Topics and topic filters use the fleet namespace of SPEC section 5 (fleet/{site}/{robot}/...),
        # which the demo prefix does not match: an mfc-demo-* ARN would deny the commands the cloud
        # publishes. Thing and client names must carry the mfc-demo- prefix: see the note on the
        # workload boundary resource.
        Sid    = "WorkloadIotOfDemo"
        Effect = "Allow"
        Action = ["iot:*"]
        Resource = [
          "arn:aws:iot:${var.region}:${local.account_id}:client/mfc-demo-*",
          "arn:aws:iot:${var.region}:${local.account_id}:thing/mfc-demo-*",
          "arn:aws:iot:${var.region}:${local.account_id}:rolealias/mfc-demo-*",
          "arn:aws:iot:${var.region}:${local.account_id}:topic/fleet/*",
          "arn:aws:iot:${var.region}:${local.account_id}:topicfilter/fleet/*",
        ]
      },
      {
        # IoT certificate creation has no resource type in the Service Authorization Reference, so it is
        # the one IoT action granted on *. AWS generates the certificate id, so no ARN can narrow it
        # (THREAT_MODEL R20).
        Sid      = "WorkloadIotCreateCertificate"
        Effect   = "Allow"
        Action   = ["iot:CreateKeysAndCertificate"]
        Resource = ["*"]
      },
      {
        # Certificate ids are generated by AWS, so cert/* cannot carry the mfc-demo- prefix. DeleteCertificate
        # is never granted: a retired certificate is revoked and kept as evidence (THREAT_MODEL R20).
        Sid    = "WorkloadIotCertificates"
        Effect = "Allow"
        Action = [
          "iot:UpdateCertificate",
          "iot:AttachPolicy",
          "iot:DetachPolicy",
        ]
        Resource = ["arn:aws:iot:${var.region}:${local.account_id}:cert/*"]
      },
      {
        # Attaching and detaching a certificate to and from a thing are the only certificate actions with a
        # thing in the request, so the thing ARN is bound here: a workload role cannot bind its certificate
        # to a thing outside the demo prefix (THREAT_MODEL R20). The key iot:thingArn is absent from the
        # other certificate actions, which is why they stay in WorkloadIotCertificates without it.
        Sid      = "WorkloadIotThingPrincipals"
        Effect   = "Allow"
        Action   = ["iot:AttachThingPrincipal", "iot:DetachThingPrincipal"]
        Resource = ["arn:aws:iot:${var.region}:${local.account_id}:cert/*"]
        Condition = {
          ArnLike = { "iot:thingArn" = "arn:aws:iot:${var.region}:${local.account_id}:thing/mfc-demo-*" }
        }
      },
      {
        Sid    = "WorkloadKinesisVideoOfDemo"
        Effect = "Allow"
        Action = ["kinesisvideo:*"]
        Resource = [
          "arn:aws:kinesisvideo:${var.region}:${local.account_id}:channel/mfc-demo-*/*",
          "arn:aws:kinesisvideo:${var.region}:${local.account_id}:stream/mfc-demo-*/*",
        ]
      },
      {
        # Existing user pools are used only when they carry the project tag, as in the deploy policy.
        Sid       = "WorkloadCognitoUserPoolsOfProject"
        Effect    = "Allow"
        Action    = ["cognito-idp:*"]
        Resource  = ["arn:aws:cognito-idp:${var.region}:${local.account_id}:userpool/*"]
        Condition = { StringEquals = { "aws:ResourceTag/project" = "mfc" } }
      },
      {
        Sid    = "WorkloadDataOfDemo"
        Effect = "Allow"
        Action = ["dynamodb:*"]
        Resource = [
          "arn:aws:dynamodb:${var.region}:${local.account_id}:table/mfc-demo-*",
          "arn:aws:dynamodb:${var.region}:${local.account_id}:table/mfc-demo-*/index/*",
          "arn:aws:dynamodb:${var.region}:${local.account_id}:table/mfc-demo-*/stream/*",
        ]
      },
      {
        Sid    = "WorkloadQueuesAndTopicsOfDemo"
        Effect = "Allow"
        Action = ["sqs:*", "sns:*"]
        Resource = [
          "arn:aws:sqs:${var.region}:${local.account_id}:mfc-demo-*",
          "arn:aws:sns:${var.region}:${local.account_id}:mfc-demo-*",
        ]
      },
      {
        Sid    = "WorkloadBucketsOfDemo"
        Effect = "Allow"
        Action = ["s3:*"]
        Resource = [
          "arn:aws:s3:::mfc-demo-*",
          "arn:aws:s3:::mfc-demo-*/*",
        ]
      },
      {
        Sid      = "WorkloadParametersOfDemo"
        Effect   = "Allow"
        Action   = ["ssm:GetParameter*"]
        Resource = ["arn:aws:ssm:${var.region}:${local.account_id}:parameter/mfc-demo/*"]
      },
      {
        # The state bucket is never reachable from a workload, even with a broad identity policy.
        Sid      = "DenyStateBucket"
        Effect   = "Deny"
        Action   = ["s3:*"]
        Resource = [local.state_bucket_arn, "${local.state_bucket_arn}/*"]
      },
      {
        # The audit evidence is never reachable from a workload (SEC-LOG-1). Without this Deny,
        # WorkloadBucketsOfDemo would cover the trail bucket through the mfc-demo-* pattern, and the
        # deploy role could delete trail objects through a workload role it creates (THREAT_MODEL R15).
        # CloudTrail writes as a service principal, which a boundary does not govern.
        Sid      = "DenyTrailBucket"
        Effect   = "Deny"
        Action   = ["s3:*"]
        Resource = local.trail_bucket_arns
      },
      {
        Sid      = "DenyIamAndRoleChaining"
        Effect   = "Deny"
        Action   = ["iam:*", "sts:AssumeRole", "organizations:*"]
        Resource = ["*"]
      },
    ]
  }
}

resource "aws_iam_policy" "workload_boundary" {
  # The boundary is a ceiling, not a grant: it allows the actions of each workload service, narrowed
  # to the demo resources where AWS allows it. Each workload role narrows them further with its own
  # identity policy. Its explicit Denies remove IAM, role chaining, the state bucket and the
  # trail bucket.
  #
  # Naming: the boundary matches thing and client names, and KVS channels named after the thing
  # (SPEC SEC-ID-2), on the mfc-demo- prefix. A robot thing without that prefix is refused by the
  # boundary, so the robot naming must carry it.
  #checkov:skip=CKV_AWS_290:Write actions are present on purpose: the boundary is a ceiling; the identity policy of each role scopes the writes.
  #checkov:skip=CKV_AWS_355:Resource "*" is used only for xray:*, cloudwatch:PutMetricData and iot:CreateKeysAndCertificate, which have no resource-level ARN; each identity policy narrows them.
  name        = "mfc-demo-workload-boundary"
  path        = local.ci_path
  description = "Permission boundary applied to every workload role of the demo."
  policy      = jsonencode(local.workload_boundary_policy)
}

resource "aws_iam_policy" "plan_guard" {
  name        = "mfc-demo-plan-guard"
  path        = local.ci_path
  description = "Removes the data reads that the read-only plan role must not perform."
  policy      = jsonencode(local.plan_guard_policy)
}

resource "aws_iam_policy" "deploy_core" {
  # The state bucket Deny moved from this policy to deploy-data (cc1188c). deploy-data is created
  # first, so that an apply never leaves a window in which neither policy holds that Deny.
  depends_on = [aws_iam_policy.deploy_data]

  name        = "mfc-demo-deploy-core"
  path        = local.ci_path
  description = "Deploy role: Terraform state, account services and IAM limited to the workload path."
  policy      = jsonencode(local.deploy_core_policy)
}

resource "aws_iam_policy" "deploy_data" {
  name        = "mfc-demo-deploy-data"
  path        = local.ci_path
  description = "Deploy role: S3, DynamoDB and SQS of the demo."
  policy      = jsonencode(local.deploy_data_policy)
}

resource "aws_iam_policy" "deploy_compute" {
  name        = "mfc-demo-deploy-compute"
  path        = local.ci_path
  description = "Deploy role: Lambda functions, layers, event source mappings and API Gateway paths."
  policy      = jsonencode(local.deploy_compute_policy)
}

resource "aws_iam_policy" "deploy_edge" {
  #checkov:skip=CKV_AWS_287:cognito-identity:* lets the deploy role manage identity pools, including their credential-issuing actions. It is scoped to identitypool/* and only the CI deploy role holds it (THREAT_MODEL T8).
  name        = "mfc-demo-deploy-edge"
  path        = local.ci_path
  description = "Deploy role: CloudFront, Cognito user pools and identity pools of the demo."
  policy      = jsonencode(local.deploy_edge_policy)
}

resource "aws_iam_policy" "deploy_iot" {
  name        = "mfc-demo-deploy-iot"
  path        = local.ci_path
  description = "Deploy role: IoT topic rules, policies, role aliases, thing groups and Kinesis Video channels."
  policy      = jsonencode(local.deploy_iot_policy)
}

resource "aws_iam_policy" "e2e" {
  name        = "mfc-demo-gha-e2e"
  path        = local.ci_path
  description = "E2E role: creates and deletes the ephemeral Operator of a test run and invokes the robots function."
  policy      = jsonencode(local.e2e_policy)
}
