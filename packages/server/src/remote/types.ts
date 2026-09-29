export type RemoteDevice = {
  id: string
  name: string
  online: boolean | null
  url: string | null
  current: boolean
}

export type RemoteAccessState = {
  configured: boolean
  /** The GitHub account remote access runs as, by its account id. Signing in is the account page's. */
  accountId: string | null
  account: { name: string; username: string; avatarUrl?: string } | null
  enabled: boolean
  status: "disabled" | "connecting" | "online" | "offline"
  deviceName: string
  url: string | null
  devices: RemoteDevice[]
  error: "configuration" | "authentication" | "connection" | null
}
