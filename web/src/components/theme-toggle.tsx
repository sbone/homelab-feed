import { Button } from "./ui/button";
import { useTheme, type Theme } from "../lib/theme";

const options: Array<{ value: Theme; label: string }> = [
  { value: "light", label: "Light" },
  { value: "system", label: "System" },
  { value: "dark", label: "Dark" },
];

export function ThemeToggle() {
  const { setTheme, theme } = useTheme();

  return (
    <div className="theme-toggle" aria-label="Theme">
      {options.map((option) => (
        <Button
          key={option.value}
          type="button"
          variant={theme === option.value ? "default" : "ghost"}
          size="sm"
          aria-pressed={theme === option.value}
          onClick={() => setTheme(option.value)}
        >
          {option.label}
        </Button>
      ))}
    </div>
  );
}
