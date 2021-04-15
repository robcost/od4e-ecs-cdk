import * as cdk from '@aws-cdk/core';
import * as ecs from '@aws-cdk/aws-ecs';
import * as elbv2 from '@aws-cdk/aws-elasticloadbalancingv2';
import * as efs from '@aws-cdk/aws-efs';
import * as ec2 from '@aws-cdk/aws-ec2';
import { Protocol, SubnetType } from '@aws-cdk/aws-ec2';
import { LogGroup, RetentionDays } from "@aws-cdk/aws-logs";
import { AwsLogDriver } from '@aws-cdk/aws-ecs';
import { ManagedPolicy, Role, ServicePrincipal } from '@aws-cdk/aws-iam';
import * as servicediscovery from '@aws-cdk/aws-servicediscovery';
import { RemovalPolicy } from '@aws-cdk/core';
import * as aws_ecs_patterns from "@aws-cdk/aws-ecs-patterns";

export class Od4EEcsCdkStack extends cdk.Stack {
  constructor(scope: cdk.Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // -------------------------------------------------------
    // Setup global constructs
    // -------------------------------------------------------

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


    // -------------------------------------------------------
    // Setup Cloud Map Service Discovery
    // service discovery config... https://stackoverflow.com/questions/66799660/using-cdk-to-define-ecs-fargate-cluster-with-service-discovery-without-load-bal
    // -------------------------------------------------------

    const serviceName = "cluster";
    const namespaceName = "od4e.internal";

    const namespace = new servicediscovery.PrivateDnsNamespace(this, 'Namespace', {
      name: namespaceName,
      vpc,
      description: 'Service Discovery namespace for the OD4E cluster.'
    });

    const service = namespace.createService('Service', {
      dnsRecordType: servicediscovery.DnsRecordType.A_AAAA,
      dnsTtl: cdk.Duration.seconds(30),
      loadBalancer: true,
    });
  
    // -------------------------------------------------------
    // Setup security groups
    // -------------------------------------------------------

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

    // -------------------------------------------------------
    // Setup EFS mount points for cluster nodes
    // -------------------------------------------------------

    const fileSystem = new efs.FileSystem(this, "AppEFS", {
      vpc,
      lifecyclePolicy: efs.LifecyclePolicy.AFTER_14_DAYS,
      performanceMode: efs.PerformanceMode.GENERAL_PURPOSE,
      throughputMode: efs.ThroughputMode.BURSTING,
      securityGroup: EfsSg,
      vpcSubnets: vpc.selectSubnets({subnetType: SubnetType.PRIVATE}),
      encrypted: true,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const efsAccessPoint = new efs.AccessPoint(this, "EfsAccessPoint", {
      path: '/files',
      fileSystem,
      createAcl: {
        ownerGid: '82',
        ownerUid: '1000',
        permissions: '777'
      },
      posixUser: {
        gid: '82',
        uid: '1000'
      }
    });

    efsAccessPoint.node.addDependency(fileSystem)

    // -------------------------------------------------------
    // Setup OD4E Cluster Nodes
    // -------------------------------------------------------

    const od4eTaskDefinition = new ecs.FargateTaskDefinition(this, 'TaskDefOD4E', {
      memoryLimitMiB: 8192,
      cpu: 2048,
      executionRole: TaskIamRole,
      taskRole: TaskIamRole
    });

    od4eTaskDefinition.addVolume({
      name: 'data',
      efsVolumeConfiguration: {
        fileSystemId: fileSystem.fileSystemId,
        rootDirectory: '/',
        transitEncryption: 'ENABLED',
        authorizationConfig: {
          accessPointId: efsAccessPoint.accessPointId
        }
      }
    });

    const od4eContainer = od4eTaskDefinition.addContainer("odfe-node1", {
      image: ecs.ContainerImage.fromRegistry("amazon/opendistro-for-elasticsearch:1.12.0"),
      environment: {
        //'cluster.name': 'odfe-cluster',
        'node.name': `${serviceName + '.' + namespaceName}`,
        'discovery.type': 'single-node',
        //'discovery.seed_hosts': `${serviceName + '.' + namespaceName}`, //'odfe-node1,odfe-node2'
        //'cluster.initial_master_nodes': `${serviceName + '.' + namespaceName}`,
        'bootstrap.memory_lock': 'true',
        'ES_JAVA_OPTS': '-Xms512m -Xmx512m',
        //'sonar.search.javaAdditionalOpts': '-Dnode.store.allow_mmapfs=false'
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
        softLimit: 350000,
        hardLimit: 350000,
        name: ecs.UlimitName.NOFILE
      }
    );

    od4eContainer.addMountPoints({
      readOnly: false,
      containerPath: "/usr/share/elasticsearch/data",
      sourceVolume: "data"
    })

    const od4eService = new ecs.FargateService(this, 'od4eService', {
      cluster,
      taskDefinition: od4eTaskDefinition,
      circuitBreaker: { rollback: true },
      platformVersion: ecs.FargatePlatformVersion.VERSION1_4,
      securityGroups: [od4eSg],
      cloudMapOptions: {
        name: serviceName,
        cloudMapNamespace: namespace,
        dnsRecordType: servicediscovery.DnsRecordType.A,
      },
    });

    // enable ECS Execute Command incase we need to jump inside a container to debug
    /* const myCfnService = od4eService.service as any;
    const cfnService = myCfnService.resource as ecs.CfnService;
    cfnService.enableExecuteCommand = true; */


    // -------------------------------------------------------
    // Setup Kibana node
    // -------------------------------------------------------

    const kibanaTaskDefinition = new ecs.FargateTaskDefinition(this, 'TaskDefKibana', {
      memoryLimitMiB: 2048,
      cpu: 1024,
      executionRole: TaskIamRole,
      taskRole: TaskIamRole,
    });

    const kibanaContainer = kibanaTaskDefinition.addContainer("OD4EKibana", {
      image: ecs.ContainerImage.fromRegistry("amazon/opendistro-for-elasticsearch-kibana:1.12.0"),
      environment: {
        ELASTICSEARCH_URL: `https://${serviceName + '.' + namespaceName}:9200`,
        ELASTICSEARCH_HOSTS: `https://${serviceName + '.' + namespaceName}:9200`,
      },
      logging: new AwsLogDriver({
        logGroup: od4eLogGroup,
        streamPrefix: 'od4e-kibana'
      }),
    });

    kibanaContainer.addPortMappings({
      containerPort: 5601
    })

    const kibanaService = new aws_ecs_patterns.ApplicationLoadBalancedFargateService(this, "KibanaFargateService", {
      cluster,
      taskDefinition: kibanaTaskDefinition,
      securityGroups: [od4eSg],
      platformVersion: ecs.FargatePlatformVersion.VERSION1_4,

      // todo: add R53 and ACM so we can do SSL...
      //certificate:
      //domainName:
      //redirectHTTP: true,
      //protocol: elbv2.ApplicationProtocol.HTTPS,
    });

    // change healthcheck to support drupal setup process
    kibanaService.targetGroup.configureHealthCheck({healthyHttpCodes: '200-499',path: '/'});
 
    /* const kibanaService = new ecs.FargateService(this, 'kibanaService', {
      cluster,
      taskDefinition: kibanaTaskDefinition,
      circuitBreaker: { rollback: true },
      platformVersion: ecs.FargatePlatformVersion.VERSION1_4,
      securityGroups: [od4eSg],
    }); */

    od4eService.connections.allowFrom(fileSystem, ec2.Port.tcp(2049));
    od4eService.connections.allowTo(fileSystem, ec2.Port.tcp(2049));
    od4eService.connections.allowFrom(kibanaService.service, ec2.Port.tcp(9200));
    od4eService.connections.allowTo(kibanaService.service, ec2.Port.tcp(9200));
    fileSystem.connections.allowFrom(od4eService,ec2.Port.tcp(9200));
    fileSystem.connections.allowTo(od4eService,ec2.Port.tcp(9200));

    /* const lb = new elbv2.ApplicationLoadBalancer(this, 'LB', { vpc, internetFacing: true });
    const listener = lb.addListener('Listener', { port: 80 });
    const targetGroup = listener.addTargets('ECS1', {
      port: 5601,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [kibanaService]
    });

    console.log(od4eService.serviceName + '.' + namespace.namespaceName) */

  }
}
