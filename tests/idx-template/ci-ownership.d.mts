export type CiOwnership = Readonly<{
  containerId: string;
  containerName: string;
  imageId: string;
  networkId: string;
  networkName: string;
  networkAddress: string;
  volumeName: string;
  dataDirectory: string;
  hostPort: 54434;
  internalPort: 5432;
  startedAt: string;
}>;
export function ciContainerId(
  environment: Readonly<Record<string, string | undefined>>,
  platform: string,
): string | undefined;
export function verifyCiContainerOwnership(
  container: unknown,
  id: string,
  environment: Readonly<Record<string, string | undefined>>,
  platform: string,
): CiOwnership;
export function verifyCiImageAndNetwork(ownership: CiOwnership, image: unknown, network: unknown): void;
export function verifyCiDatabaseTarget(
  ownership: CiOwnership,
  actual: unknown,
  postgisAvailable: boolean,
): void;
