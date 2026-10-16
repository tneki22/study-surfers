/** Баллончик с кнопки генерации и табло фоновых задач. */
export function SprayWidget({ busy = false }: { busy?: boolean }) {
  return (
    <span className={`spray-widget${busy ? " is-busy" : ""}`} aria-hidden="true">
      <span className="spray-widget-mist" />
      <span className="spray-widget-can" />
    </span>
  );
}
