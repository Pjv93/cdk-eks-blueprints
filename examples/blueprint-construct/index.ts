import * as cdk from 'aws-cdk-lib';
import * as ec2 from "aws-cdk-lib/aws-ec2";
import { CapacityType, KubernetesVersion, NodegroupAmiType } from 'aws-cdk-lib/aws-eks';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import { Construct } from "constructs";
import * as blueprints from '../../lib';
import { logger, userLog } from '../../lib/utils';
import * as team from '../teams';
import { CfnWorkspace } from 'aws-cdk-lib/aws-aps';

const burnhamManifestDir = './examples/teams/team-burnham/';
const rikerManifestDir = './examples/teams/team-riker/';
const teamManifestDirList = [burnhamManifestDir, rikerManifestDir];
const blueprintID = 'blueprint-construct-dev';

export interface BlueprintConstructProps {
    /**
     * Id
     */
    id: string
}

export default class BlueprintConstruct {
    constructor(scope: Construct, props: cdk.StackProps) {

        blueprints.HelmAddOn.validateHelmVersions = true;
        blueprints.HelmAddOn.failOnVersionValidation = false;
        logger.settings.minLevel = 3; // info
        userLog.settings.minLevel = 2; // debug

        const teams: Array<blueprints.Team> = [
            new team.TeamTroi,
            new team.TeamRiker(scope, teamManifestDirList[1]),
            new team.TeamBurnham(scope, teamManifestDirList[0]),
            new team.TeamPlatform(process.env.CDK_DEFAULT_ACCOUNT!)
        ];

        const nodeRole = new blueprints.CreateRoleProvider("blueprint-node-role", new iam.ServicePrincipal("ec2.amazonaws.com"),
        [
            iam.ManagedPolicy.fromAwsManagedPolicyName("AmazonEKSWorkerNodePolicy"),
            iam.ManagedPolicy.fromAwsManagedPolicyName("AmazonEC2ContainerRegistryReadOnly"),
            iam.ManagedPolicy.fromAwsManagedPolicyName("AmazonSSMManagedInstanceCore")
        ]);

        const ampWorkspaceName = "blueprints-amp-workspace";
        const ampWorkspace: CfnWorkspace = blueprints.getNamedResource(ampWorkspaceName);

        const apacheAirflowS3Bucket = new blueprints.CreateS3BucketProvider({
            id: 'apache-airflow-s3-bucket-id',
            s3BucketProps: { removalPolicy: cdk.RemovalPolicy.DESTROY }
        });
        const apacheAirflowEfs = new blueprints.CreateEfsFileSystemProvider({
            name: 'blueprints-apache-airflow-efs',    
        });

        const addOns: Array<blueprints.ClusterAddOn> = [
            new blueprints.addons.AwsLoadBalancerControllerAddOn(),
            new blueprints.addons.AppMeshAddOn(),
            new blueprints.addons.CertManagerAddOn(),
            new blueprints.addons.KubeStateMetricsAddOn(),
            new blueprints.addons.PrometheusNodeExporterAddOn(),
            new blueprints.addons.AdotCollectorAddOn(),
            new blueprints.addons.AmpAddOn({
                ampPrometheusEndpoint: ampWorkspace.attrPrometheusEndpoint,
            }),
            new blueprints.addons.XrayAdotAddOn(),
            new blueprints.addons.XrayAddOn(),
            // new blueprints.addons.CloudWatchAdotAddOn(),
            // new blueprints.addons.ContainerInsightsAddOn(),
            new blueprints.addons.IstioBaseAddOn(),
            new blueprints.addons.IstioControlPlaneAddOn(),
            new blueprints.addons.CalicoOperatorAddOn(),
            new blueprints.addons.MetricsServerAddOn(),
            new blueprints.addons.SecretsStoreAddOn(),
            new blueprints.addons.ArgoCDAddOn(),
            new blueprints.addons.SSMAgentAddOn(),
            new blueprints.addons.NginxAddOn({
                values: {
                    controller: { service: { create: false } }
                }
            }),
            new blueprints.addons.VeleroAddOn(),
            new blueprints.addons.VpcCniAddOn({
                customNetworkingConfig: {
                    subnets: [
                        blueprints.getNamedResource("secondary-cidr-subnet-0"),
                        blueprints.getNamedResource("secondary-cidr-subnet-1"),
                        blueprints.getNamedResource("secondary-cidr-subnet-2"),
                    ]   
                },
                awsVpcK8sCniCustomNetworkCfg: true,
                eniConfigLabelDef: 'topology.kubernetes.io/zone',
                serviceAccountPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName("AmazonEKS_CNI_Policy")]
            }),
            new blueprints.addons.CoreDnsAddOn(),
            new blueprints.addons.KubeProxyAddOn(),
            new blueprints.addons.OpaGatekeeperAddOn(),
            new blueprints.addons.AckAddOn({
                id: "s3-ack",
                createNamespace: true,
                skipVersionValidation: true,
                serviceName: blueprints.AckServiceName.S3
            }),
            new blueprints.addons.KarpenterAddOn({
                requirements: [
                    { key: 'node.kubernetes.io/instance-type', op: 'In', vals: ['m5.2xlarge'] },
                    { key: 'topology.kubernetes.io/zone', op: 'NotIn', vals: ['us-west-2c']},
                    { key: 'kubernetes.io/arch', op: 'In', vals: ['amd64','arm64']},
                    { key: 'karpenter.sh/capacity-type', op: 'In', vals: ['spot']},
                ],
                subnetTags: {
                    "Name": "blueprint-construct-dev/blueprint-construct-dev-vpc/PrivateSubnet1",
                },
                securityGroupTags: {
                    "kubernetes.io/cluster/blueprint-construct-dev": "owned",
                },
                taints: [{
                    key: "workload",
                    value: "test",
                    effect: "NoSchedule",
                }],
                consolidation: { enabled: true },
                ttlSecondsUntilExpired: 2592000,
                weight: 20,
                interruptionHandling: true,
                limits: {
                    resources: {
                        cpu: 20,
                        memory: "64Gi",
                    }
                }
            }),
            new blueprints.addons.AwsNodeTerminationHandlerAddOn(),
            new blueprints.addons.KubeviousAddOn(),
            new blueprints.addons.EbsCsiDriverAddOn({
                kmsKeys: [
                  blueprints.getResource( context => new kms.Key(context.scope, "ebs-csi-driver-key", { alias: "ebs-csi-driver-key"})),
                ],
              }
            ),
            new blueprints.addons.EfsCsiDriverAddOn({
              replicaCount: 1,
              kmsKeys: [
                blueprints.getResource( context => new kms.Key(context.scope, "efs-csi-driver-key", { alias: "efs-csi-driver-key"})),
              ],
            }),
            new blueprints.addons.KedaAddOn({
                podSecurityContextFsGroup: 1001,
                securityContextRunAsGroup: 1001,
                securityContextRunAsUser: 1001,
                irsaRoles: ["CloudWatchFullAccess", "AmazonSQSFullAccess"]
            }),
            new blueprints.addons.AWSPrivateCAIssuerAddon(),
            // new blueprints.addons.JupyterHubAddOn({
            //     efsConfig: {
            //         pvcName: "efs-persist",
            //         removalPolicy: cdk.RemovalPolicy.DESTROY,
            //         capacity: '10Gi',
            //     },
            //     serviceType: blueprints.JupyterHubServiceType.CLUSTERIP,
            //     notebookStack: 'jupyter/datascience-notebook',
            //     values: { prePuller: { hook: { enabled: false }}}
            // }),
            new blueprints.EmrEksAddOn(),
            new blueprints.AwsBatchAddOn(),
            // Commenting due to conflicts with `CloudWatchLogsAddon`
            // new blueprints.AwsForFluentBitAddOn(),
            new blueprints.FluxCDAddOn(),
            new blueprints.GrafanaOperatorAddon(),
            new blueprints.CloudWatchLogsAddon({
                logGroupPrefix: '/aws/eks/blueprints-construct-dev', 
                logRetentionDays: 30
            }),
            new blueprints.ApacheAirflowAddOn({
                enableLogging: true,
                s3Bucket: 'apache-airflow-s3-bucket-provider',
                enableEfs: true,
                efsFileSystem: 'apache-airflow-efs-provider'
            }),
            new blueprints.ExternalsSecretsAddOn(),
        ];

        // Instantiated to for helm version check.
        new blueprints.ExternalDnsAddOn({
            hostedZoneResources: [ blueprints.GlobalResources.HostedZone ]
        });

        const clusterProvider = new blueprints.GenericClusterProvider({
            version: KubernetesVersion.V1_25,
            tags: {
                "Name": "blueprints-example-cluster",
                "Type": "generic-cluster"
            },
            mastersRole: blueprints.getResource(context => {
                return new iam.Role(context.scope, 'AdminRole', { assumedBy: new iam.AccountRootPrincipal() });
            }),
            managedNodeGroups: [
                addGenericNodeGroup(),
                addCustomNodeGroup(),
                addWindowsNodeGroup()
            ]
        });

        const executionRolePolicyStatement:iam. PolicyStatement [] = [
            new iam.PolicyStatement({
              resources: ['*'],
              actions: ['s3:*'],
            }),
            new iam.PolicyStatement({
              resources: ['*'],   
              actions: ['glue:*'],
            }),
            new iam.PolicyStatement({
              resources: ['*'],
              actions: [
                'logs:*',
              ],
            }),
          ];
      
        const dataTeam: blueprints.EmrEksTeamProps = {
              name:'dataTeam',
              virtualClusterName: 'batchJob',
              virtualClusterNamespace: 'batchjob',
              createNamespace: true,
              executionRoles: [
                  {
                      executionRoleIamPolicyStatement: executionRolePolicyStatement,
                      executionRoleName: 'myBlueprintExecRole'
                  }
              ]
          };

        const batchTeam: blueprints.BatchEksTeamProps = {
            name: 'batch-a',
            namespace: 'aws-batch',
            envName: 'batch-a-comp-env',
            computeResources: {
                envType: blueprints.BatchEnvType.EC2,
                allocationStrategy: blueprints.BatchAllocationStrategy.BEST,
                priority: 10,
                minvCpus: 0,
                maxvCpus: 128,
                instanceTypes: ["m5", "c4.4xlarge"]
            },
            jobQueueName: 'team-a-job-queue',
        };

        blueprints.EksBlueprint.builder()
            .addOns(...addOns)
            .resourceProvider(blueprints.GlobalResources.Vpc, new blueprints.VpcProvider(undefined, {
                primaryCidr: "10.2.0.0/16", 
                secondaryCidr: "100.64.0.0/16",
                secondarySubnetCidrs: ["100.64.0.0/24","100.64.1.0/24","100.64.2.0/24"]
            }))
            .resourceProvider("node-role", nodeRole)
            .resourceProvider('apache-airflow-s3-bucket-provider', apacheAirflowS3Bucket)
            .resourceProvider('apache-airflow-efs-provider', apacheAirflowEfs)
            .clusterProvider(clusterProvider)
            .resourceProvider(ampWorkspaceName, new blueprints.CreateAmpProvider(ampWorkspaceName, ampWorkspaceName))
            .teams(...teams, new blueprints.EmrEksTeam(dataTeam), new blueprints.BatchEksTeam(batchTeam))
            .enableControlPlaneLogTypes(blueprints.ControlPlaneLogType.API)
            .build(scope, blueprintID, props);

    }
}

function addGenericNodeGroup(): blueprints.ManagedNodeGroup {

    return {
        id: "mng1",
        amiType: NodegroupAmiType.AL2_X86_64,
        instanceTypes: [new ec2.InstanceType('m5.4xlarge')],
        desiredSize: 2,
        maxSize: 3, 
        nodeRole: blueprints.getNamedResource("node-role") as iam.Role,
        nodeGroupSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
        launchTemplate: {
            // You can pass Custom Tags to Launch Templates which gets Propogated to worker nodes.
            tags: {
                "Name": "Mng1",
                "Type": "Managed-Node-Group",
                "LaunchTemplate": "Custom",
                "Instance": "ONDEMAND"
            },
            requireImdsv2: false
        }
    }
}

function addCustomNodeGroup(): blueprints.ManagedNodeGroup {
    
    const userData = ec2.UserData.forLinux();
    userData.addCommands(`/etc/eks/bootstrap.sh ${blueprintID}`); 

    return {
        id: "mng2-customami",
        instanceTypes: [new ec2.InstanceType('t3.large')],
        nodeGroupCapacityType: CapacityType.SPOT,
        desiredSize: 0,
        minSize: 0,
        nodeRole: blueprints.getNamedResource("node-role") as iam.Role,
        launchTemplate: {
            tags: {
                "Name": "Mng2",
                "Type": "Managed-Node-Group",
                "LaunchTemplate": "Custom",
                "Instance": "SPOT"
            },
            machineImage: ec2.MachineImage.genericLinux({
                'eu-west-1': 'ami-00805477850d62b8c',
                'us-east-1': 'ami-08e520f5673ee0894',
                'us-west-2': 'ami-0403ff342ceb30967',
                'us-east-2': 'ami-07109d69738d6e1ee',
                'us-west-1': 'ami-07bda4b61dc470985',
                'us-gov-west-1': 'ami-0e9ebbf0d3f263e9b',
                'us-gov-east-1':'ami-033eb9bc6daf8bfb1'
            }),
            userData: userData,
        }
    }
}

function addWindowsNodeGroup(): blueprints.ManagedNodeGroup {
    
    const windowsUserData = ec2.UserData.forWindows();
    windowsUserData.addCommands(`
      $ErrorActionPreference = 'Stop'
      $EKSBootstrapScriptPath = "C:\\\\Program Files\\\\Amazon\\\\EKS\\\\Start-EKSBootstrap.ps1"
      Try {
        & $EKSBootstrapScriptPath -EKSClusterName 'blueprint-construct-dev'
      } Catch {
        Throw $_
      }
    `);
    const ebsDeviceProps: ec2.EbsDeviceProps = {
        deleteOnTermination: false,
        volumeType: ec2.EbsDeviceVolumeType.GP2
    };

    return {
        id: "mng3-windowsami",
        amiType: NodegroupAmiType.AL2_X86_64,
        instanceTypes: [new ec2.InstanceType('m5.4xlarge')],
        desiredSize: 0,
        minSize: 0, 
        nodeRole: blueprints.getNamedResource("node-role") as iam.Role,
        launchTemplate: {
            blockDevices: [
                {
                    deviceName: "/dev/sda1",
                    volume: ec2.BlockDeviceVolume.ebs(50, ebsDeviceProps),
                }
            ],
            machineImage: ec2.MachineImage.genericWindows({
                'us-east-1': 'ami-0e80b8d281637c6c1',
                'us-east-2': 'ami-039ecff89038848a6',
                'us-west-1': 'ami-0c0815035bf1efb6e',
                'us-west-2': 'ami-029e1340b254a7667',
                'eu-west-1': 'ami-09af50f599f7f882c',
                'eu-west-2': 'ami-0bf1fec1eaef78230',
            }),
            securityGroup: blueprints.getNamedResource("my-cluster-security-group") as ec2.ISecurityGroup,
            tags: {
                "Name": "Mng3",
                "Type": "Managed-WindowsNode-Group",
                "LaunchTemplate": "WindowsLT",
                "kubernetes.io/cluster/blueprint-construct-dev": "owned"
            },
            userData: windowsUserData,
        }
    }
}




