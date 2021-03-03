import * as cdk from '@aws-cdk/core';
import * as ecs from '@aws-cdk/aws-ecs';
import * as elbv2 from '@aws-cdk/aws-elasticloadbalancingv2';
import * as efs from '@aws-cdk/aws-efs';
import * as ec2 from '@aws-cdk/aws-ec2';
import { SubnetType } from '@aws-cdk/aws-ec2';
import { LogGroup, RetentionDays } from "@aws-cdk/aws-logs";
import { AwsLogDriver } from '@aws-cdk/aws-ecs';
import { ManagedPolicy, Role, ServicePrincipal } from '@aws-cdk/aws-iam';
//import * as servicediscovery from '@aws-cdk/aws-servicediscovery';

export class Od4EEcsCdkStack extends cdk.Stack {
  constructor(scope: cdk.Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const od4eLogGroup = new LogGroup(this, 'od4eLogGroup', {
      retention: RetentionDays.ONE_MONTH
    })

    const TaskIamRole = new Role(this, 'od4eTaskRole', {
      assumedBy: new ServicePrincipal('ecs-tasks.amazonaws.com'),
      description: `IAM Task Role for OD4E ECS Fargate`,
    });

    const vpc = new ec2.Vpc(this, 'TheVPC', {
      cidr: "10.0.0.0/16"
   })

/*    const namespace = new servicediscovery.PrivateDnsNamespace(this, 'Namespace', {
    name: 'service.local',
    vpc,
  });

  const service = namespace.createService('Service', {
    dnsRecordType: servicediscovery.DnsRecordType.A_AAAA,
    dnsTtl: cdk.Duration.seconds(30),
    loadBalancer: true,
  }); */

   const EfsSg = new ec2.SecurityGroup(this, 'EfsSecurityGroup', {
      vpc,
      allowAllOutbound: true,
      description: `Security Group for ECS EFS access`
    });

    const od4eSg = new ec2.SecurityGroup(this, 'od4eSecurityGroup', {
      vpc,
      allowAllOutbound: true,
      description: `Security Group for ECS od4e access`
    });

    const cluster = new ecs.Cluster(this, 'Cluster', {
      vpc: vpc
    });

    // Create the file system
    const fileSystem = new efs.FileSystem(this, "AppEFS", {
      vpc,
      lifecyclePolicy: efs.LifecyclePolicy.AFTER_14_DAYS,
      performanceMode: efs.PerformanceMode.GENERAL_PURPOSE,
      throughputMode: efs.ThroughputMode.BURSTING,
      securityGroup: EfsSg,
      vpcSubnets: vpc.selectSubnets({subnetType: SubnetType.PRIVATE})
    });

    const kibanaTaskDefinition = new ecs.FargateTaskDefinition(this, 'TaskDefKibana', {
      memoryLimitMiB: 2048,
      cpu: 1024,
      executionRole: TaskIamRole,
      taskRole: TaskIamRole
    });

    const kibanaContainer = kibanaTaskDefinition.addContainer("OD4EKibana", {
      image: ecs.ContainerImage.fromRegistry("amazon/opendistro-for-elasticsearch-kibana:1.12.0"),
      environment: {
        ELASTICSEARCH_URL: 'https://odfe-node1:9200',
        ELASTICSEARCH_HOSTS: 'https://odfe-node1:9200',
      },
      logging: new AwsLogDriver({
        logGroup: od4eLogGroup,
        streamPrefix: 'od4e-kibana'
      })
    });

    kibanaContainer.addPortMappings({
      containerPort: 5601
    })

    const kibanaService = new ecs.FargateService(this, 'kibanaService', {
      cluster,
      taskDefinition: kibanaTaskDefinition,
      circuitBreaker: { rollback: true },
      platformVersion: ecs.FargatePlatformVersion.VERSION1_4,
      securityGroups: [od4eSg],
    });

    const od4eTaskDefinition = new ecs.FargateTaskDefinition(this, 'TaskDefOD4E', {
      memoryLimitMiB: 8192,
      cpu: 2048,
      volumes: [
        {
          name: 'EfsPersistedVolume',
          efsVolumeConfiguration: {
            fileSystemId: fileSystem.fileSystemId,
            rootDirectory: '/',
          }
        }
      ],
      executionRole: TaskIamRole,
      taskRole: TaskIamRole
    });

    const od4eContainer = od4eTaskDefinition.addContainer("odfe-node1", {
      image: ecs.ContainerImage.fromRegistry("amazon/opendistro-for-elasticsearch:1.12.0"),
      environment: {
        'cluster.name': 'odfe-cluster',
        'node.name': 'odfe-node1',
        'discovery.seed_hosts': 'odfe-node1', //'odfe-node1,odfe-node2'
        'cluster.initial_master_nodes': 'odfe-node1',
        'bootstrap.memory_lock': 'true',
        'ES_JAVA_OPTS': '-Xms512m -Xmx512m',
      },
      logging: new AwsLogDriver({
        logGroup: od4eLogGroup,
        streamPrefix: 'od4e-node'
      })
    });

    od4eContainer.addPortMappings({
      containerPort: 9200
    })

    od4eContainer.addUlimits(
      {
        softLimit: -1,
        hardLimit: -1,
        name: ecs.UlimitName.MEMLOCK
      },
      {
        softLimit: 65536,
        hardLimit: 65536,
        name: ecs.UlimitName.NOFILE
      }
    );

    od4eContainer.addMountPoints({
      containerPath: "/usr/share/elasticsearch/data",
      sourceVolume: "EfsPersistedVolume",
      readOnly: false,
    })

    const od4eService = new ecs.FargateService(this, 'od4eService', {
      cluster,
      taskDefinition: od4eTaskDefinition,
      circuitBreaker: { rollback: true },
      platformVersion: ecs.FargatePlatformVersion.VERSION1_4,
      securityGroups: [od4eSg],
    });

    od4eService.connections.allowFrom(fileSystem, ec2.Port.tcp(2049));
    od4eService.connections.allowTo(fileSystem, ec2.Port.tcp(2049));

    const lb = new elbv2.ApplicationLoadBalancer(this, 'LB', { vpc, internetFacing: true });
    const listener = lb.addListener('Listener', { port: 80 });
    const targetGroup = listener.addTargets('ECS1', {
      port: 5601,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [kibanaService]
    });

  }
}
