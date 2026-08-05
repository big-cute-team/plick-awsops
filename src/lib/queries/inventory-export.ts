// Detail queries for the inventory XLSX export — one entry per sheet.
// Kept separate from page queries so export columns stay stable.
// 인벤토리 XLSX 내보내기 전용 상세 쿼리 — 시트당 한 항목.
export interface ExportSheet {
  sheet: string; // Excel sheet name (<=31 chars)
  sql: string;
}

export const exportSheets: ExportSheet[] = [
  {
    sheet: 'EC2',
    sql: `
      SELECT instance_id, tags ->> 'Name' AS name, instance_type, instance_state,
        private_ip_address::text, public_ip_address::text, vpc_id, subnet_id,
        placement_availability_zone AS availability_zone, launch_time
      FROM aws_ec2_instance ORDER BY launch_time DESC NULLS LAST`,
  },
  {
    sheet: 'RDS',
    sql: `
      SELECT db_instance_identifier, engine, engine_version, class, status,
        multi_az, allocated_storage, vpc_id, availability_zone, endpoint_address
      FROM aws_rds_db_instance ORDER BY db_instance_identifier`,
  },
  {
    sheet: 'S3',
    sql: `
      SELECT name, region, creation_date, versioning_enabled
      FROM aws_s3_bucket ORDER BY creation_date DESC NULLS LAST`,
  },
  {
    sheet: 'Lambda',
    sql: `
      SELECT name, runtime, memory_size, timeout, vpc_id, last_modified
      FROM aws_lambda_function ORDER BY last_modified DESC NULLS LAST`,
  },
  {
    sheet: 'EBS Volumes',
    sql: `
      SELECT volume_id, tags ->> 'Name' AS name, volume_type, size, state,
        encrypted, availability_zone, create_time
      FROM aws_ebs_volume ORDER BY create_time DESC NULLS LAST`,
  },
  {
    sheet: 'EBS Snapshots',
    sql: `
      SELECT snapshot_id, volume_id, volume_size, state, encrypted, start_time, description
      FROM aws_ebs_snapshot ORDER BY start_time DESC NULLS LAST`,
  },
  {
    sheet: 'VPCs',
    sql: `
      SELECT vpc_id, tags ->> 'Name' AS name, cidr_block::text, is_default, state
      FROM aws_vpc ORDER BY name NULLS LAST`,
  },
  {
    sheet: 'Subnets',
    sql: `
      SELECT subnet_id, tags ->> 'Name' AS name, vpc_id, cidr_block::text,
        availability_zone, available_ip_address_count, map_public_ip_on_launch
      FROM aws_vpc_subnet ORDER BY vpc_id, availability_zone`,
  },
  {
    sheet: 'Load Balancers',
    sql: `
      SELECT name, 'application' AS type, scheme, vpc_id, dns_name, created_time
      FROM aws_ec2_application_load_balancer
      UNION ALL
      SELECT name, 'network' AS type, scheme, vpc_id, dns_name, created_time
      FROM aws_ec2_network_load_balancer
      ORDER BY created_time DESC NULLS LAST`,
  },
  {
    sheet: 'Gateways',
    sql: `
      SELECT 'nat' AS type, nat_gateway_id AS id, vpc_id, tags ->> 'Name' AS name, state
      FROM aws_vpc_nat_gateway
      UNION ALL
      SELECT 'igw' AS type, internet_gateway_id AS id,
        attachments -> 0 ->> 'VpcId' AS vpc_id, tags ->> 'Name' AS name,
        attachments -> 0 ->> 'State' AS state
      FROM aws_vpc_internet_gateway
      ORDER BY type, id`,
  },
  {
    sheet: 'Security Groups',
    sql: `
      SELECT group_id, group_name, vpc_id, description
      FROM aws_vpc_security_group ORDER BY vpc_id, group_name`,
  },
  {
    sheet: 'IAM Users',
    sql: `
      SELECT name, arn, create_date, mfa_enabled, password_last_used
      FROM aws_iam_user ORDER BY name`,
  },
  {
    sheet: 'IAM Roles',
    sql: `
      SELECT name, arn, create_date, description, max_session_duration
      FROM aws_iam_role ORDER BY name`,
  },
  {
    sheet: 'ECS Services',
    sql: `
      SELECT service_name, cluster_arn, status, desired_count, running_count, launch_type
      FROM aws_ecs_service ORDER BY service_name`,
  },
  {
    sheet: 'DynamoDB',
    sql: `
      SELECT name, billing_mode, item_count, table_size_bytes, creation_date_time
      FROM aws_dynamodb_table ORDER BY name`,
  },
  {
    sheet: 'ElastiCache',
    sql: `
      SELECT cache_cluster_id, engine, engine_version, cache_node_type,
        num_cache_nodes, cache_cluster_status, preferred_availability_zone
      FROM aws_elasticache_cluster ORDER BY cache_cluster_id`,
  },
  {
    sheet: 'CloudFront',
    sql: `
      SELECT id, domain_name, status, enabled, aliases::text
      FROM aws_cloudfront_distribution ORDER BY id`,
  },
  {
    sheet: 'WAF Web ACLs',
    sql: `
      SELECT name, scope, description
      FROM aws_wafv2_web_acl ORDER BY name`,
  },
  {
    sheet: 'ECR',
    sql: `
      SELECT repository_name, repository_uri, created_at, image_tag_mutability
      FROM aws_ecr_repository ORDER BY repository_name`,
  },
  {
    sheet: 'MSK',
    sql: `
      SELECT cluster_name, state,
        provisioned -> 'CurrentBrokerSoftwareInfo' ->> 'KafkaVersion' AS kafka_version,
        provisioned ->> 'NumberOfBrokerNodes' AS broker_nodes
      FROM aws_msk_cluster ORDER BY cluster_name`,
  },
  {
    sheet: 'OpenSearch',
    sql: `
      SELECT domain_name, engine_version
      FROM aws_opensearch_domain ORDER BY domain_name`,
  },
  {
    sheet: 'EKS Nodes',
    sql: `
      SELECT name, context_name
      FROM kubernetes_node ORDER BY context_name, name`,
  },
];
