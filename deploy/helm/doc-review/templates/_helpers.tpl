{{- define "doc-review.labels" -}}
app.kubernetes.io/name: doc-review
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version }}
{{- end -}}

{{- define "doc-review.selector" -}}
app.kubernetes.io/name: doc-review
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "doc-review.needsVolume" -}}
{{- if or (eq .Values.storage.type "pvc") (eq .Values.database.type "embedded") -}}true{{- end -}}
{{- end -}}


{{- define "doc-review.image" -}}
{{ .Values.image.repository }}:{{ .Values.image.tag | default .Chart.AppVersion }}
{{- end -}}

{{- define "doc-review.migrationJob" -}}
{{- if and (eq .Values.database.type "postgres") .Values.migrations.job -}}true{{- end -}}
{{- end -}}

{{- define "doc-review.podSecurityContext" -}}
runAsNonRoot: true
runAsUser: 10001
runAsGroup: 10001
fsGroup: 10001
seccompProfile:
  type: RuntimeDefault
{{- end -}}

{{- define "doc-review.containerSecurityContext" -}}
allowPrivilegeEscalation: false
readOnlyRootFilesystem: true
capabilities:
  drop: [ALL]
{{- end -}}
