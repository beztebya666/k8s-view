{{/* Common labels */}}
{{- define "k8s-view.labels" -}}
app.kubernetes.io/name: k8s-view
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}

{{- define "k8s-view.selectorLabels" -}}
app.kubernetes.io/name: k8s-view
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{- define "k8s-view.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default .Release.Name .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end }}
