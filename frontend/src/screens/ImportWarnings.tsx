import { AlertTriangle } from "lucide-react";
import type { JobWarning } from "../api/types";
import { readingRecovery, warningLocation } from "./readingHelp";

export function ImportWarnings({ warnings }: { warnings: JobWarning[] }) {
  const recovery = readingRecovery(warnings);
  if (!warnings.length) return null;
  return (
    <div className="import-warning-panel" role="status" aria-label="Предупреждения при чтении файлов">
      <ul className="import-warnings">
        {warnings.map((warning, index) => (
          <li key={`${warning.code}-${index}`}>
            <AlertTriangle size={15} aria-hidden="true" />
            <div>
              {warningLocation(warning) && <strong>{warningLocation(warning)}</strong>}
              <p>{warning.message}</p>
            </div>
          </li>
        ))}
      </ul>
      {recovery && (
        <div className="import-reading-help">
          <strong>Если материал прочитан неверно, выберите один из двух способов:</strong>
          <ol>{recovery.steps.map((step) => <li key={step}>{step}</li>)}</ol>
          <p>{recovery.formulaHelp}</p>
          <p>Если часть текста или формул потерялась, карточки могут оказаться неполными или неверными.</p>
        </div>
      )}
    </div>
  );
}
