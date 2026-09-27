export type RemoteDevice = {
  id: string
  name: string
  online: boolean | null
  url: string | null
  current: boolean
}

export type RemoteAccessState = {
  configured: boolean
  account: { name: string; username: string; avatarUrl?: string } | null
  authorization: { userCode: string; verificationUri: string; expiresAt: number } | null
  enabled: boolean
  status: "disabled" | "connecting" | "online" | "offline"
  deviceName: string
  url: string | null
  devices: RemoteDevice[]
  error: "configuration" | "authentication" | "connection" | null
}
