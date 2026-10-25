{{- define "revision-tesis.labels" -}}
app.kubernetes.io/name: revision-tesis
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version }}
{{- end -}}

{{- define "revision-tesis.selector" -}}
app.kubernetes.io/name: revision-tesis
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "revision-tesis.needsVolume" -}}
{{- if or (eq .Values.storage.type "pvc") (eq .Values.database.type "embedded") -}}true{{- end -}}
{{- end -}}


{{- define "revision-tesis.image" -}}
{{ .Values.image.repository }}:{{ .Values.image.tag | default .Chart.AppVersion }}
{{- end -}}

{{- define "revision-tesis.migrationJob" -}}
{{- if and (eq .Values.database.type "postgres") .Values.migrations.job -}}true{{- end -}}
{{- end -}}

{{- define "revision-tesis.podSecurityContext" -}}
runAsNonRoot: true
runAsUser: 10001
runAsGroup: 10001
fsGroup: 10001
seccompProfile:
  type: RuntimeDefault
{{- end -}}

{{- define "revision-tesis.containerSecurityContext" -}}
allowPrivilegeEscalation: false
readOnlyRootFilesystem: true
capabilities:
  drop: [ALL]
{{- end -}}
