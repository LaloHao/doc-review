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
