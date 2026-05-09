{{/*
Expand the chart name. Truncated to 63 chars (label max) and trimmed of
any trailing dash so the result stays a valid DNS-1123 label.
*/}}
{{- define "k8s-view.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/*
Fully qualified app name. Honors fullnameOverride; otherwise composes
"<release>-<chart>" but collapses the "<release>" duplicate when the user
already named the release after the chart (the conventional install).
*/}}
{{- define "k8s-view.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{/*
Chart name + version, used in app.kubernetes.io/managed-by-style labels.
*/}}
{{- define "k8s-view.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/*
Common labels — applied to every chart-managed object. Adds optional
commonLabels from values.yaml so cluster-wide ownership tooling can match.
*/}}
{{- define "k8s-view.labels" -}}
helm.sh/chart: {{ include "k8s-view.chart" . }}
{{ include "k8s-view.selectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: k8s-view
{{- with .Values.commonLabels }}
{{ toYaml . }}
{{- end }}
{{- end -}}

{{/*
Selector labels — must be stable across upgrades. Anything in commonLabels
is intentionally NOT mirrored here (mutating a Deployment selector breaks
the upgrade).
*/}}
{{- define "k8s-view.selectorLabels" -}}
app.kubernetes.io/name: {{ include "k8s-view.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{/*
Common annotations — added to every chart-managed object when
commonAnnotations is set in values.yaml.
*/}}
{{- define "k8s-view.commonAnnotations" -}}
{{- with .Values.commonAnnotations }}
{{ toYaml . }}
{{- end }}
{{- end -}}

{{/*
ServiceAccount name — defaults to the release fullname when create=true.
*/}}
{{- define "k8s-view.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "k8s-view.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{/*
Image reference — composes "<repo>@<digest>" when digest is set, otherwise
"<repo>:<tag|appVersion>". Used everywhere the chart references the image
so digest pinning is a one-line override.
*/}}
{{- define "k8s-view.image" -}}
{{- $tag := default .Chart.AppVersion .Values.image.tag -}}
{{- if .Values.image.digest -}}
{{ .Values.image.repository }}@{{ .Values.image.digest }}
{{- else -}}
{{ .Values.image.repository }}:{{ $tag }}
{{- end -}}
{{- end -}}

{{/*
Secret name for credentials (basicAuth / OIDC / LDAP). Single Secret carries
all of them — components reference different keys. existingSecret values
short-circuit this and reference the user's pre-created Secret instead.
*/}}
{{- define "k8s-view.credentialsSecretName" -}}
{{- printf "%s-credentials" (include "k8s-view.fullname" .) -}}
{{- end -}}

{{/*
True when the chart should manage its own Secret (i.e. *any* credentials
are inlined and the user hasn't pointed at an existingSecret for them).
The Secret is omitted entirely when every credential block is either
disabled or external — keeps `helm template` clean.
*/}}
{{- define "k8s-view.shouldCreateSecret" -}}
{{- $create := false -}}
{{- if and .Values.auth.basicAuth.enabled (not .Values.auth.basicAuth.existingSecret) -}}{{- $create = true -}}{{- end -}}
{{- if and .Values.auth.oidc.enabled (not .Values.auth.oidc.existingSecret) (.Values.auth.oidc.clientSecret) -}}{{- $create = true -}}{{- end -}}
{{- if and .Values.auth.ldap.enabled (not .Values.auth.ldap.existingSecret) (.Values.auth.ldap.bindPassword) -}}{{- $create = true -}}{{- end -}}
{{- $create -}}
{{- end -}}

{{/*
PVC name. Honors persistence.existingClaim when set so users can attach a
pre-provisioned volume.
*/}}
{{- define "k8s-view.pvcName" -}}
{{- if .Values.persistence.existingClaim -}}
{{- .Values.persistence.existingClaim -}}
{{- else -}}
{{- printf "%s-data" (include "k8s-view.fullname" .) -}}
{{- end -}}
{{- end -}}
