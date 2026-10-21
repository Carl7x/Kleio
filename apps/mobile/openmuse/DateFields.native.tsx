import { View } from "react-native";
import { datePartLabel } from "./chat-stream-rules";
import { Field } from "./ui";
export interface DateFieldsProps {
  label: string;
  date: string;
  time: string;
  allDay: boolean;
  onChange: (date: string, time: string) => void;
}
export default function DateFields({ label, date, time, allDay, onChange }: DateFieldsProps) {
  return (
    <View style={{ flexDirection: "row", gap: 12 }}>
      <View style={{ flex: 1.2 }}>
        <Field
          label={datePartLabel(label, "date")}
          value={date}
          onChangeText={(value) => onChange(value, time)}
          placeholder="年-月-日"
          keyboardType="numbers-and-punctuation"
          returnKeyType={allDay ? "done" : "next"}
        />
      </View>
      {!allDay && (
        <View style={{ flex: 1 }}>
          <Field
            label={datePartLabel(label, "time")}
            value={time}
            onChangeText={(value) => onChange(date, value)}
            placeholder="时:分（24 小时）"
            keyboardType="numbers-and-punctuation"
            returnKeyType="done"
          />
        </View>
      )}
    </View>
  );
}
