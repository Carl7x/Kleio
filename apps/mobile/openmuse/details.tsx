import * as FileSystem from "expo-file-system/legacy";
import * as Sharing from "expo-sharing";
import {
  CalendarDays,
  Check,
  Clock3,
  Download,
  Edit3,
  ExternalLink,
  FileText,
  Globe2,
  Mail as MailIcon,
  Reply,
  RotateCw,
  Save,
  Send,
  ShieldCheck,
  Trash2,
  X,
} from "lucide-react-native";
import { useEffect, useState } from "react";
import { ActivityIndicator, Image, Linking, Platform, Text, View } from "react-native";
import {
  type ActionProposal,
  type Artifact,
  type BrowserSession,
  type CalendarEvent,
  type EmailDraft,
  type EventDraft,
  emailDraftSchema,
  eventDraftSchema,
  type Mail,
  type ProposalInput,
} from "../../../packages/openmuse-domain/src";
import { DelegateSheet, NotificationsSheet, TaskDetail } from "./agent-ui";
import {
  approvalAttachmentLine,
  approvalCalendarName,
  approvalEndNote,
  approvalExpirySentence,
  approvalKindLabel,
  approvalProposeLabel,
  approvalStatusLabel,
  browserOpenLabel,
  browserSessionSubtitle,
  calendarDraftError,
  fileAddedLine,
  fileDetailLine,
  formFieldLabel,
  type FormIssue,
  mailDraftError,
  mailRecipientLine,
  mailReplySubject,
  mailThreadSubtitle,
  pdfDownloadsAddedNotice,
  surfaceError,
  unsupportedFieldNote,
} from "./chat-stream-rules";
import BrowserConsole from "./BrowserConsole";
import { browserAddress, browserSite } from "./browser-address";
import { ComputerSheet } from "./computer";
import DateTimeEditor from "./DateTimeEditor";
import { localDateTime, zonedInstant } from "./date-time";
import PdfReader from "./PdfReader";
import {
  Button,
  Card,
  CheckRow,
  Chip,
  colors,
  dateLabel,
  Empty,
  ErrorNotice,
  Field,
  LinkRow,
  resultSummary,
  SectionHeading,
  Sheet,
  s,
  timeLabel,
} from "./ui";
import { type Detail, useWorkspace } from "./workspace";
export function Details({ detail }: { detail: Detail }) {
  const { close, navigate } = useWorkspace();
  if (detail.type === "computer") return <ComputerSheet />;
  if (detail.type === "task") return <TaskDetail taskId={detail.taskId} />;
  if (detail.type === "delegate")
    return (
      <DelegateSheet
        key={`${detail.goalId}:${detail.milestoneId}`}
        goalId={detail.goalId}
        milestoneId={detail.milestoneId}
      />
    );
  if (detail.type === "notifications") return <NotificationsSheet />;
  if (detail.type === "mail") return <MailDetail mail={detail.mail} />;
  if (detail.type === "email") return <EmailEditor draft={detail.draft} />;
  if (detail.type === "event")
    return <EventEditor event={detail.event} draft={detail.draft} neighbors={detail.neighbors} />;
  if (detail.type === "file") return <FileDetail file={detail.file} />;
  if (detail.type === "review") return <ReviewDetail initial={detail.action} />;
  if (detail.type === "browser") return <BrowserDetail initial={detail.browser} />;
  return (
    <Sheet title="你的工作台" subtitle="一点空间，装下一切。" onClose={close}>
      {[
        { section: "mail" as const, title: "邮件", icon: MailIcon },
        { section: "calendar" as const, title: "日历", icon: CalendarDays },
        { section: "browser" as const, title: "浏览器", icon: Globe2 },
        { section: "files" as const, title: "文件", icon: FileText },
        { section: "activity" as const, title: "动态", icon: Clock3 },
        { section: "connections" as const, title: "连接", icon: ShieldCheck },
      ].map((item) => (
        <LinkRow
          key={item.section}
          title={item.title}
          icon={item.icon}
          onPress={() => {
            navigate(item.section);
            close();
          }}
        />
      ))}
    </Sheet>
  );
}
function MailDetail({ mail: m }: { mail: Mail }) {
  const { workspace: w, api, refresh, open, close } = useWorkspace();
  const enabled = w.runtime.capabilities?.google === true;
  const [error, setError] = useState("");
  const [importing, setImporting] = useState("");
  async function importAttachment(reference: string) {
    if (!enabled || !w.runtime.capabilities?.pdf) return;
    setError("");
    setImporting(reference);
    try {
      const file = await api.request<Artifact>("/api/mail/import-attachment", { reference });
      await refresh();
      open({ type: "file", file });
    } catch (e) {
      setError(surfaceError("附件没有导入。", errorText(e)));
    } finally {
      setImporting("");
    }
  }
  const [thread, setThread] = useState<Mail[]>([m]);
  const [loading, setLoading] = useState(true);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return;
    }
    let active = true;
    setLoading(true);
    setError("");
    void api
      .request<Mail[]>(`/api/mail/threads/${encodeURIComponent(m.threadId)}`)
      .then((items) => {
        if (active) setThread(items.sort((a, b) => a.date.localeCompare(b.date)));
      })
      .catch((e) => {
        if (active) setError(surfaceError("这封邮件暂时没有载入。", errorText(e)));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [api, m.threadId, retry, enabled]);
  return (
    <Sheet
      title={m.subject}
      subtitle={mailThreadSubtitle(thread.length)}
      onClose={close}
    >
      {loading && (
        <View style={[s.row, { gap: 10, paddingBottom: 20 }]}>
          <ActivityIndicator color={colors.blueDark} />
          <Text style={s.muted}>正在加载对话…</Text>
        </View>
      )}
      {thread.map((message) => (
        <Card key={message.id} style={{ marginBottom: 16 }}>
          <View style={s.between}>
            <View style={{ gap: 4, flex: 1 }}>
              <Text style={s.heading}>{message.sender}</Text>
              <Text style={s.small}>{message.from}</Text>
              <Text style={s.small}>{mailRecipientLine(message.to)}</Text>
            </View>
            <Text style={s.small}>
              {dateLabel(message.date)} · {timeLabel(message.date)}
            </Text>
          </View>
          <View style={s.divider} />
          <Text selectable style={[s.text, { lineHeight: 25 }]}>
            {message.body}
          </Text>
          {message.attachments.map((id) => {
            const file = w.files.find((f) => f.id === id);
            return file ? (
              <LinkRow
                key={id}
                title={file.name}
                detail={fileDetailLine({ pageCount: file.pageCount, kind: "attachment" })}
                icon={FileText}
                onPress={() => open({ type: "file", file })}
              />
            ) : (
              <Button
                key={id}
                busy={importing === id}
                disabled={!enabled || !w.runtime.capabilities?.pdf}
                icon={FileText}
                onPress={() => void importAttachment(id)}
              >
                {decodeURIComponent(id.split(":").slice(2).join(":")) || "打开附件"}
              </Button>
            );
          })}
        </Card>
      ))}
      {!enabled && <Text style={s.small}>此工作台未启用。</Text>}
      <ErrorNotice error={error} />
      {!!error && <Button onPress={() => setRetry(retry + 1)}>重新加载对话</Button>}
      <Button
        primary
        disabled={!enabled}
        icon={Reply}
        style={{ alignSelf: "flex-start" }}
        onPress={() =>
          open({
            type: "email",
            draft: {
              to: [m.from],
              subject: mailReplySubject(m.subject),
              body: "",
              cc: [],
              bcc: [],
              attachmentIds: [],
              threadId: m.threadId,
              replyToMessageId: m.id,
            },
          })
        }
      >
        写回复
      </Button>
    </Sheet>
  );
}
function EmailEditor({ draft }: { draft?: Partial<EmailDraft> & { id?: string } }) {
  const { workspace: w, api, refresh, open, close, notify } = useWorkspace();
  const enabled = w.runtime.capabilities?.google === true;
  const [to, setTo] = useState(draft?.to?.join(", ") || "");
  const [cc, setCc] = useState(draft?.cc?.join(", ") || "");
  const [bcc, setBcc] = useState(draft?.bcc?.join(", ") || "");
  const [subject, setSubject] = useState(draft?.subject || "");
  const [body, setBody] = useState(draft?.body || "");
  const [attachments, setAttachments] = useState(draft?.attachmentIds || []);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  function emails(value: string) {
    return value
      .split(/[,;\n]/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  async function save(review: boolean) {
    if (!enabled) return;
    setBusy(review ? "review" : "draft");
    setError("");
    try {
      const parsed = emailDraftSchema.safeParse({
        to: emails(to),
        cc: emails(cc),
        bcc: emails(bcc),
        subject,
        body,
        attachmentIds: attachments,
        threadId: draft?.threadId,
        replyToMessageId: draft?.replyToMessageId,
      });
      if (!parsed.success) throw new Error(mailDraftError(formIssues(parsed.error.issues)));
      if (review) {
        const action = await api.request<ActionProposal>("/api/actions", {
          kind: "email.send",
          data: parsed.data,
        });
        await refresh();
        open({ type: "review", action });
      } else {
        await api.request("/api/drafts", {
          ...parsed.data,
          ...(draft?.id ? { id: draft.id } : {}),
        });
        await refresh();
        notify("草稿已保存在 Kleio。");
        close();
      }
    } catch (e) {
      setError(surfaceError("这封邮件没有保存。", errorText(e)));
    } finally {
      setBusy("");
    }
  }
  return (
    <Sheet
      title={draft?.threadId ? "写回复" : "新邮件"}
      subtitle={
        w.profile.email.trim()
          ? `来自 ${w.profile.email} · 私密保存在 Kleio`
          : "私密保存在 Kleio"
      }
      onClose={close}
    >
      <Field
        label="收件人"
        value={to}
        onChangeText={setTo}
        placeholder="邮箱地址，逗号分隔"
        autoCapitalize="none"
        keyboardType="email-address"
      />
      <View style={{ flexDirection: "row", gap: 16 }}>
        <View style={{ flex: 1 }}>
          <Field
            label="抄送"
            value={cc}
            onChangeText={setCc}
            placeholder="可选"
            autoCapitalize="none"
          />
        </View>
        <View style={{ flex: 1 }}>
          <Field
            label="密送"
            value={bcc}
            onChangeText={setBcc}
            placeholder="可选"
            autoCapitalize="none"
          />
        </View>
      </View>
      <Field
        label="主题"
        value={subject}
        onChangeText={setSubject}
        placeholder="想说些什么？"
      />
      <Field
        label="正文"
        value={body}
        onChangeText={setBody}
        multiline
        placeholder="开始写邮件…"
        style={{ minHeight: 210 }}
      />
      {w.files.length > 0 && (
        <Card style={{ padding: 16, marginBottom: 18 }}>
          <Text style={[s.heading, { fontSize: 13, marginBottom: 5 }]}>附件</Text>
          {w.files.map((f) => (
            <CheckRow
              key={f.id}
              checked={attachments.includes(f.id)}
              label={`${f.name} · ${Math.max(1, Math.round(f.size / 1024))} KB`}
              onPress={() =>
                setAttachments(
                  attachments.includes(f.id)
                    ? attachments.filter((id) => id !== f.id)
                    : [...attachments, f.id],
                )
              }
            />
          ))}
        </Card>
      )}
      {!enabled && <Text style={s.small}>此工作台未启用。</Text>}
      <ErrorNotice error={error} />
      <View style={[s.row, { gap: 10, flexWrap: "wrap" }]}>
        <Button
          primary
          icon={ShieldCheck}
          busy={busy === "review"}
          disabled={!!busy || !enabled}
          onPress={() => void save(true)}
        >
          审阅邮件
        </Button>
        <Button
          icon={Save}
          busy={busy === "draft"}
          disabled={!!busy || !enabled}
          onPress={() => void save(false)}
        >
          保存草稿
        </Button>
      </View>
      <Text style={[s.small, { marginTop: 13 }]}>
        发送前你会核对确切收件人、正文与附件。
      </Text>
    </Sheet>
  );
}
function EventEditor({
  event: e,
  draft,
  neighbors,
}: {
  event?: CalendarEvent;
  draft?: EventDraft;
  neighbors?: CalendarEvent[];
}) {
  const seed = e || draft;
  const { workspace: w, api, open, close, refresh } = useWorkspace();
  const enabled = w.runtime.capabilities?.google === true;
  const initialStart = new Date();
  initialStart.setMinutes(0, 0, 0);
  initialStart.setHours(initialStart.getHours() + 1);
  const [title, setTitle] = useState(seed?.title || "");
  const [start, setStart] = useState(seed?.start || initialStart.toISOString());
  const [end, setEnd] = useState(
    seed?.end || new Date(initialStart.getTime() + 3600000).toISOString(),
  );
  const [allDay, setAllDay] = useState(seed?.allDay || false);
  const [zone, setZone] = useState(
    seed?.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone,
  );
  const [location, setLocation] = useState(seed?.location || "");
  const [description, setDescription] = useState(seed?.description || "");
  const [attendees, setAttendees] = useState(seed?.attendees.join(", ") || "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const conflicts = (neighbors || w.events).filter(
    (item) =>
      item.id !== e?.id &&
      Date.parse(start) < Date.parse(item.end) &&
      Date.parse(end) > Date.parse(item.start),
  );
  async function propose(remove = false) {
    if (!enabled) return;
    setBusy(true);
    setError("");
    try {
      let data: ProposalInput;
      if (remove && e) {
        data = {
          kind: "calendar.delete",
          data: { eventId: e.id, calendarId: e.calendarId, title: e.title },
        };
      } else {
        const parsed = eventDraftSchema.safeParse({
          calendarId: e?.calendarId || draft?.calendarId || "primary",
          title,
          start,
          end,
          allDay,
          timeZone: zone,
          location,
          description,
          attendees: attendees
            .split(/[,;\n]/)
            .map((a) => a.trim())
            .filter(Boolean),
        });
        if (!parsed.success) throw new Error(calendarDraftError(formIssues(parsed.error.issues), allDay));
        data = e
          ? { kind: "calendar.update", data: { ...parsed.data, eventId: e.id } }
          : { kind: "calendar.create", data: parsed.data };
      }
      const action = await api.request<ActionProposal>("/api/actions", data);
      await refresh();
      open({ type: "review", action });
    } catch (err) {
      setError(surfaceError("这个日程没有提交。", errorText(err)));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Sheet
      title={e ? "留一点时间" : "一件值得期待的事"}
      subtitle={
        e ? "编辑此日程，然后确认修改。" : "在日历中创建日程。"
      }
      onClose={close}
    >
      <Field
        label="日程标题"
        value={title}
        onChangeText={setTitle}
        placeholder="你在为什么留时间？"
      />
      <CheckRow
        label="全天日程"
        checked={allDay}
        onPress={() => {
          try {
            if (!allDay) {
              const local = localDateTime(start, zone);
              const endDay = new Date(`${local.date}T12:00:00Z`);
              endDay.setUTCDate(endDay.getUTCDate() + 1);
              setStart(local.date);
              setEnd(endDay.toISOString().slice(0, 10));
            } else {
              setStart(zonedInstant(start, "09:00", zone));
              setEnd(zonedInstant(start, "10:00", zone));
            }
            setAllDay(!allDay);
            setError("");
          } catch (cause) {
            setError(surfaceError("这个时间还没法换算。", errorText(cause)));
          }
        }}
      />
      <DateTimeEditor
        label="开始"
        value={start}
        onChange={setStart}
        timeZone={zone}
        allDay={allDay}
      />
      <DateTimeEditor label="结束" value={end} onChange={setEnd} timeZone={zone} allDay={allDay} />
      {allDay && (
        <Text style={[s.small, { marginBottom: 15 }]}>
          结束日期为日程最后一天的次日。
        </Text>
      )}
      <Field
        label="时区"
        value={zone}
        onChangeText={setZone}
        placeholder="例如 Asia/Shanghai"
      />
      <Field
        label="地点或会议链接"
        value={location}
        onChangeText={setLocation}
        placeholder="可选"
      />
      <Field
        label="参与者"
        value={attendees}
        onChangeText={setAttendees}
        placeholder="邮箱地址，逗号分隔"
      />
      <Field
        label="备注"
        value={description}
        onChangeText={setDescription}
        multiline
        placeholder="还有什么需要记住的吗？"
      />
      {!!conflicts.length && (
        <Card style={{ backgroundColor: colors.orange, padding: 16, marginBottom: 16 }}>
          <Text style={s.heading}>时间有重叠</Text>
          {conflicts.map((c) => (
            <Text key={c.id} style={s.muted}>
              {c.title} · {timeLabel(c.start, c.timeZone)}–{timeLabel(c.end, c.timeZone)}
            </Text>
          ))}
        </Card>
      )}
      {!enabled && <Text style={s.small}>此工作台未启用。</Text>}
      <ErrorNotice error={error} />
      <View style={[s.row, { gap: 10, flexWrap: "wrap" }]}>
        <Button primary icon={ShieldCheck} busy={busy} disabled={!enabled} onPress={() => void propose()}>
          {approvalProposeLabel(!!e)}
        </Button>
        {e && (
          <Button icon={Trash2} disabled={busy || !enabled} danger onPress={() => void propose(true)}>
            审阅删除
          </Button>
        )}
      </View>
    </Sheet>
  );
}
function ReviewDetail({ initial }: { initial: ActionProposal }) {
  const { workspace: w, api, refresh, close, open } = useWorkspace();
  const enabled = w.runtime.capabilities?.google === true;
  const [local, setLocal] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const action =
    local.status !== initial.status ? local : w.actions.find((a) => a.id === initial.id) || local;
  const d = action.data;
  const pending = action.status === "awaiting_review";
  async function decide(decision: "approve" | "deny") {
    if (!enabled) return;
    setBusy(true);
    setError("");
    try {
      const result = await api.request<ActionProposal>(`/api/actions/${action.id}/decide`, {
        decision,
        hash: action.hash,
      });
      setLocal(result);
      await refresh();
    } catch (e) {
      setError(surfaceError("这次确认没有完成。", errorText(e)));
    } finally {
      setBusy(false);
    }
  }
  async function edit() {
    if (!enabled) return;
    setBusy(true);
    setError("");
    try {
      let next: Detail;
      if (action.kind === "email.send")
        next = { type: "email", draft: emailDraftSchema.parse(action.data) };
      else {
        const draft = eventDraftSchema.parse(action.data);
        if (action.kind === "calendar.update") {
          const eventId = action.data.eventId;
          if (typeof eventId !== "string" || !eventId)
            throw new Error("缺少日程引用。请在日历中重新打开该日程。");
          next = { type: "event", event: { ...draft, id: eventId } };
        } else next = { type: "event", draft };
      }
      await api.request(`/api/actions/${action.id}/decide`, {
        decision: "deny",
        hash: action.hash,
      });
      await refresh();
      open(next);
    } catch (e) {
      setError(surfaceError("暂时无法编辑。", errorText(e)));
    } finally {
      setBusy(false);
    }
  }
  const email = action.kind === "email.send";
  const expiresAt = new Date(action.expiresAt);
  const expiresLabel = Number.isNaN(expiresAt.getTime())
    ? "截止时间"
    : expiresAt.toLocaleString("zh-CN", {
        year: "numeric",
        month: "long",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });
  return (
    <Sheet
      title={pending ? "最后确认一下" : action.title}
      subtitle={
        w.mode === "sample"
          ? "此操作仅留在本地工作台。"
          : "在更改已连接账户前，请核对这一操作。"
      }
      onClose={close}
    >
      <View
        style={{
          marginBottom: 10,
          paddingHorizontal: 12,
          paddingVertical: 10,
          gap: 4,
          borderRadius: 16,
          borderWidth: 1,
          borderColor: colors.line,
          borderLeftWidth: 3,
          borderLeftColor: pending ? "#8A5A24" : "#47896C",
          backgroundColor: pending ? colors.lavender : colors.card,
        }}
      >
        <View style={[s.row, { gap: 8, alignItems: "center" }]}>
          <ShieldCheck size={16} color={colors.blueDark} />
          <Text style={[s.text, { flex: 1, fontWeight: "600" }]}>{action.title}</Text>
          <Chip tint={pending ? colors.card : colors.green}>{approvalStatusLabel(action.status)}</Chip>
        </View>
        <Text style={[s.small, { marginLeft: 24 }]}>{approvalKindLabel(action.kind)}</Text>
      </View>
      <Card style={{ gap: 8, padding: 14, borderRadius: 16 }}>
        <ReviewLine label="账户" value={action.account || w.profile.email} />
        {email ? (
          <>
            <ReviewLine label="收件人" value={arrayText(d.to)} />
            <ReviewLine label="抄送" value={arrayText(d.cc) || "无"} />
            <ReviewLine label="密送" value={arrayText(d.bcc) || "无"} />
            <ReviewLine label="主题" value={String(d.subject || "")} />
            <View style={{ height: 1, backgroundColor: colors.line, marginVertical: 4 }} />
            <Text selectable style={[s.text, { lineHeight: 22 }]}>
              {String(d.body || "")}
            </Text>
            <View style={{ height: 1, backgroundColor: colors.line, marginVertical: 4 }} />
            <Text style={[s.small, { fontWeight: "600" }]}>附件</Text>
            {Array.isArray(d.attachmentIds) && d.attachmentIds.length ? (
              d.attachmentIds.map((id) => {
                const file = w.files.find((f) => f.id === id);
                return (
                  <Text key={String(id)} style={s.text}>
                    {approvalAttachmentLine(file?.name || String(id), String(id))}
                  </Text>
                );
              })
            ) : (
              <Text style={s.muted}>无附件</Text>
            )}
          </>
        ) : (
          <>
            <ReviewLine label="日程" value={String(d.title || "")} />
            {action.kind !== "calendar.delete" && (
              <>
                <ReviewLine
                  label="开始"
                  value={
                    d.allDay
                      ? String(d.start || "")
                      : `${dateLabel(String(d.start || ""), { year: "numeric", month: "short", day: "numeric", timeZone: String(d.timeZone || "UTC") })} · ${timeLabel(String(d.start || ""), String(d.timeZone || "UTC"))}`
                  }
                />
                <ReviewLine
                  label="结束"
                  value={
                    d.allDay
                      ? `${String(d.end || "")}${approvalEndNote(true)}`
                      : `${dateLabel(String(d.end || ""), { year: "numeric", month: "short", day: "numeric", timeZone: String(d.timeZone || "UTC") })} · ${timeLabel(String(d.end || ""), String(d.timeZone || "UTC"))}`
                  }
                />
                <ReviewLine label="时区" value={String(d.timeZone || "")} />
                <ReviewLine label="全天" value={d.allDay ? "是" : "否"} />
                <ReviewLine label="地点" value={String(d.location || "无")} />
                <ReviewLine label="参与者" value={arrayText(d.attendees) || "仅你自己"} />
                <ReviewLine label="备注" value={String(d.description || "无")} />
              </>
            )}
            <ReviewLine label="日历" value={approvalCalendarName(String(d.calendarId || "primary"))} />
            <Text style={s.small}>
              {action.kind === "calendar.delete"
                ? "将删除此日程，并可能通知参与者。"
                : "参与者可能会收到来自已连接日历的邀请或更新。"}
            </Text>
          </>
        )}
      </Card>
      {!enabled && <Text style={s.small}>此工作台未启用。</Text>}
      <ErrorNotice error={error || action.error} />
      {!!action.result && (
        <Card style={{ marginTop: 10, backgroundColor: colors.green, padding: 12, borderRadius: 16 }}>
          <Text selectable style={s.text}>
            {resultSummary(action.result)}
          </Text>
        </Card>
      )}
      {pending ? (
        <>
          <Text style={[s.small, { marginTop: 10, marginBottom: 8 }]}>
            {approvalExpirySentence(expiresLabel)}
          </Text>
          <View style={[s.row, { gap: 10, flexWrap: "wrap" }]}>
            <Button primary icon={Check} busy={busy} disabled={!enabled} onPress={() => void decide("approve")}>
              {w.mode === "sample"
                ? "仅本地批准"
                : email
                  ? "批准并发送"
                  : "批准更改"}
            </Button>
            {action.kind !== "calendar.delete" && (
              <Button icon={Edit3} disabled={busy || !enabled} onPress={() => void edit()}>
                编辑详情
              </Button>
            )}
            <Button icon={X} disabled={busy || !enabled} onPress={() => void decide("deny")}>
              不要继续
            </Button>
          </View>
        </>
      ) : (
        <Button style={{ alignSelf: "flex-start", marginTop: 10 }} onPress={close}>
          完成
        </Button>
      )}
    </Sheet>
  );
}
function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function formIssues(
  issues: readonly { path: readonly PropertyKey[]; code: string; format?: unknown }[],
): FormIssue[] {
  return issues.map((issue) => ({
    path: issue.path.map((part) => String(part)),
    code: issue.code,
    format: typeof issue.format === "string" ? issue.format : undefined,
  }));
}

function arrayText(value: unknown) {
  return Array.isArray(value) ? value.map(String).join(", ") : "";
}
function ReviewLine({ label, value }: { label: string; value: string }) {
  return (
    <View style={{ gap: 2 }}>
      <Text style={[s.small, { fontWeight: "600" }]}>{label}</Text>
      <Text selectable style={s.text}>
        {value}
      </Text>
    </View>
  );
}
function FileDetail({ file: f }: { file: Artifact }) {
  const { api, refresh, open, close, workspace } = useWorkspace();
  const enabled = workspace.runtime.capabilities?.pdf === true;
  const [values, setValues] = useState<Record<string, string | boolean>>(() =>
    Object.fromEntries(
      (f.fields || [])
        .filter((field) => field.type !== "unsupported")
        .map((field) => [
          field.name,
          field.type === "checkbox" ? field.value === "true" || field.value === "是" : field.value,
        ]),
    ),
  );
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const url = api.url(f.url || `/api/files/${f.id}/content`);
  async function fill() {
    if (!enabled) return;
    setBusy(true);
    setError("");
    try {
      const file = await api.request<Artifact>(`/api/files/${f.id}/fill`, { fields: values });
      await refresh();
      open({ type: "file", file });
    } catch (e) {
      setError(surfaceError("这份副本没有保存。", errorText(e)));
    } finally {
      setBusy(false);
    }
  }
  async function share() {
    if (!enabled) return;
    setError("");
    try {
      if (Platform.OS === "web") {
        await Linking.openURL(url);
        return;
      }
      const target = `${FileSystem.cacheDirectory}${f.id}.pdf`;
      await FileSystem.downloadAsync(url, target, {
        headers: { Authorization: `Bearer ${api.token}` },
      });
      if (await Sharing.isAvailableAsync())
        await Sharing.shareAsync(target, { mimeType: "application/pdf", UTI: "com.adobe.pdf" });
      else throw new Error("此设备不支持分享。");
    } catch (e) {
      setError(surfaceError("暂时无法分享。", errorText(e)));
    }
  }
  return (
    <Sheet
      title={f.name}
      subtitle={fileDetailLine({ pageCount: f.pageCount, bytes: f.size, source: f.source })}
      onClose={close}
      wide
    >
      <PdfReader url={url} token={api.token} pageCount={f.pageCount} />
      <View style={[s.row, { gap: 10, marginVertical: 18, flexWrap: "wrap" }]}>
        <Button icon={Download} disabled={!enabled} onPress={() => void share()}>
          {Platform.OS === "web" ? "打开 / 下载" : "保存或分享"}
        </Button>
        <Button
          icon={Send}
          disabled={!enabled || !workspace.runtime.capabilities?.google}
          onPress={() => open({ type: "email", draft: { attachmentIds: [f.id] } })}
        >
          附加到邮件
        </Button>
      </View>
      {f.fields && f.fields.length > 0 && (
        <Card>
          <SectionHeading title="填写此表单" />
          <Text style={[s.muted, { marginBottom: 18 }]}>
            在下方填写信息。保存会生成新副本，保留原件。
          </Text>
          {f.fields.map((field) =>
            field.type === "unsupported" ? (
              <Text key={field.name} style={s.muted}>
                {unsupportedFieldNote(field.name)}
              </Text>
            ) : field.type === "checkbox" ? (
              <CheckRow
                key={field.name}
                checked={!!values[field.name]}
                label={formFieldLabel(field.name)}
                onPress={() => setValues({ ...values, [field.name]: !values[field.name] })}
              />
            ) : (
              <Field
                key={field.name}
                label={formFieldLabel(field.name)}
                value={String(values[field.name] || "")}
                onChangeText={(value) => setValues({ ...values, [field.name]: value })}
              />
            ),
          )}
          <Button primary icon={Save} busy={busy} disabled={!enabled} onPress={() => void fill()}>
            保存已填写副本
          </Button>
        </Card>
      )}
      {!enabled && <Text style={s.small}>此工作台未启用。</Text>}
      <ErrorNotice error={error} />
      <Text style={[s.small, { marginTop: 15 }]}>
        {fileAddedLine(dateLabel(f.createdAt), Boolean(f.parentId))}
      </Text>
    </Sheet>
  );
}
function BrowserDetail({ initial }: { initial: BrowserSession }) {
  const { workspace: w, api, refresh, close, notify } = useWorkspace();
  const enabled = w.runtime.capabilities?.browser === true;
  const [local, setLocal] = useState(initial);
  const [url, setUrl] = useState(initial.url);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [retry, setRetry] = useState(0);
  const latest = w.browsers.find((b) => b.id === initial.id);
  const browser = {
    ...(latest && latest.updatedAt > local.updatedAt ? latest : local),
    consoleUrl: local.consoleUrl,
    previewUrl: local.previewUrl,
  };
  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return;
    }
    let active = true;
    setLoading(true);
    setError("");
    void api
      .request<BrowserSession>(`/api/browsers/${initial.id}`)
      .then((session) => {
        if (active) {
          setLocal(session);
          setLoading(false);
        }
      })
      .catch((e) => {
        if (active) setError(surfaceError("浏览器没有连上。", errorText(e)));
      });
    return () => {
      active = false;
    };
  }, [api, initial.id, retry, enabled]);
  async function importDownloads() {
    if (!enabled || !w.runtime.capabilities?.pdf) return;
    setBusy(true);
    setError("");
    try {
      const result = await api.request<{
        files: Artifact[];
        failures: { name: string; message: string }[];
      }>(`/api/browsers/${browser.id}/import-downloads`, {});
      await refresh();
      if (result.failures.length)
        setError(
          surfaceError(
            "有的下载没有导入。",
            result.failures.map((failure) => `${failure.name}: ${failure.message}`).join("\n"),
          ),
        );
      const files = result.files;
      notify(
        files.length
          ? pdfDownloadsAddedNotice(files.length)
          : pdfDownloadsAddedNotice(0),
      );
    } catch (e) {
      setError(surfaceError("下载没有导入。", errorText(e)));
    } finally {
      setBusy(false);
    }
  }
  async function mutate(end = false) {
    if (busy || loading || !enabled) return;
    setBusy(true);
    setError("");
    try {
      const result = await api.request<BrowserSession>(
        `/api/browsers/${browser.id}/${end ? "close" : browser.status === "closed" ? "reopen" : "navigate"}`,
        end ? {} : { url: browserAddress(url) },
      );
      setLocal(result);
      setUrl(result.url);
      await refresh();
      if (end) close();
    } catch (e) {
      setError(surfaceError(end ? "会话没有关闭。" : "页面没有打开。", errorText(e)));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Sheet
      title={browserSite(browser.url)}
      subtitle={browserSessionSubtitle(browser.status, timeLabel(browser.updatedAt))}
      onClose={close}
      wide
    >
      <View style={[s.row, { gap: 10, marginBottom: 16 }]}>
        <View style={{ flex: 1 }}>
          <Field
            label="网站地址"
            value={url}
            onChangeText={setUrl}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            returnKeyType="go"
            onSubmitEditing={() => void mutate()}
          />
        </View>
        <Button primary busy={busy} disabled={!enabled || loading || !url.trim()} onPress={() => void mutate()}>
          {browserOpenLabel(browser.status)}
        </Button>
      </View>
      {!enabled && <Text style={s.small}>此工作台未启用。</Text>}
      <ErrorNotice error={error} />
      {loading ? (
        <View style={[s.row, { gap: 10, paddingVertical: 24 }]}>
          {error ? (
            <Button onPress={() => setRetry(retry + 1)}>重试连接</Button>
          ) : (
            <>
              <ActivityIndicator color={colors.blueDark} />
              <Text style={s.muted}>正在连接浏览器…</Text>
            </>
          )}
        </View>
      ) : browser.status === "active" && browser.consoleUrl ? (
        <BrowserConsole url={api.url(browser.consoleUrl)} />
      ) : browser.status === "active" && browser.previewUrl ? (
        <Image
          source={{ uri: api.url(browser.previewUrl) }}
          style={{ width: "100%", height: 450, backgroundColor: colors.canvas }}
          resizeMode="contain"
        />
      ) : (
        <Empty
          icon={Globe2}
          title={
            browser.status === "closed" ? "此会话已关闭" : "预览不可用"
          }
          detail={
            browser.status === "closed"
              ? "个人资料与下载已保存。重新打开可从离开处继续。"
              : "重新连接以继续使用已保存的浏览器配置。"
          }
        />
      )}
      <View style={[s.row, { gap: 10, marginTop: 18, flexWrap: "wrap" }]}>
        {!loading && browser.status === "active" && browser.consoleUrl && (
          <Button
            icon={ExternalLink}
            onPress={() => void Linking.openURL(api.url(browser.consoleUrl || ""))}
          >
            在窗口中打开浏览器
          </Button>
        )}
        {!loading && (
          <Button icon={RotateCw} disabled={busy || !enabled} onPress={() => setRetry(retry + 1)}>
            刷新连接
          </Button>
        )}
        {!loading && browser.status !== "closed" && (
          <Button icon={Download} busy={busy} disabled={!enabled || !w.runtime.capabilities?.pdf} onPress={() => void importDownloads()}>
            导入 PDF 下载
          </Button>
        )}
        {!loading && browser.status !== "closed" && (
          <Button icon={X} danger busy={busy} disabled={!enabled} onPress={() => void mutate(true)}>
            关闭会话
          </Button>
        )}
      </View>
    </Sheet>
  );
}
