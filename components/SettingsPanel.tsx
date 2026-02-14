import React, { useState, useEffect, useMemo } from 'react';
import { CONFIG_SCHEMA, loadConfig, saveConfig, type ConfigField } from '../services/configService';

interface Props {
  isOpen: boolean;
  onClose: () => void;
}

export const SettingsPanel: React.FC<Props> = ({ isOpen, onClose }) => {
  const [config, setConfig] = useState<Record<string, any>>({});
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (isOpen) {
      loadConfig().then(setConfig);
    }
  }, [isOpen]);

  const groups = useMemo(() => {
    const g: Record<string, ConfigField[]> = {};
    for (const field of CONFIG_SCHEMA) {
      if (!g[field.group]) g[field.group] = [];
      g[field.group].push(field);
    }
    return g;
  }, []);

  const handleChange = (key: string, value: any) => {
    setConfig(prev => ({ ...prev, [key]: value }));
    setSaved(false);
  };

  const handleSave = async () => {
    setSaving(true);
    const ok = await saveConfig(config);
    setSaving(false);
    if (ok) {
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    }
  };

  const handleReset = () => {
    const defaults: Record<string, any> = {};
    for (const field of CONFIG_SCHEMA) {
      defaults[field.key] = field.default;
    }
    setConfig(defaults);
    setSaved(false);
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm">
      <div className="bg-gray-900 border border-gray-700 rounded-lg w-full max-w-2xl max-h-[80vh] overflow-hidden flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-gray-700">
          <h2 className="text-lg font-bold text-cyan-300">Settings</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-white text-xl">&times;</button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-4 space-y-6 custom-scrollbar">
          {Object.entries(groups).map(([group, fields]) => (
            <div key={group}>
              <h3 className="text-sm font-semibold text-cyan-400 mb-3 border-b border-gray-700/50 pb-1">{group}</h3>
              <div className="space-y-3">
                {fields.map(field => (
                  <div key={field.key} className="flex items-center justify-between gap-4">
                    <div className="flex-1">
                      <label className="text-xs text-gray-300">{field.label}</label>
                      {field.description && (
                        <div className="text-[10px] text-gray-500">{field.description}</div>
                      )}
                    </div>
                    <div className="w-32">
                      {field.type === 'boolean' ? (
                        <button
                          onClick={() => handleChange(field.key, !config[field.key])}
                          className={`w-12 h-6 rounded-full transition-colors ${config[field.key] ? 'bg-cyan-600' : 'bg-gray-600'}`}
                        >
                          <div className={`w-5 h-5 bg-white rounded-full transition-transform ${config[field.key] ? 'translate-x-6' : 'translate-x-0.5'}`} />
                        </button>
                      ) : field.type === 'select' ? (
                        <select
                          value={config[field.key] || field.default}
                          onChange={e => handleChange(field.key, e.target.value)}
                          className="w-full bg-gray-800 border border-gray-600 rounded px-2 py-1 text-xs text-white"
                        >
                          {field.options?.map(opt => (
                            <option key={opt} value={opt}>{opt}</option>
                          ))}
                        </select>
                      ) : (
                        <input
                          type="number"
                          value={config[field.key] ?? field.default}
                          min={field.min}
                          max={field.max}
                          step={field.step}
                          onChange={e => handleChange(field.key, parseFloat(e.target.value))}
                          className="w-full bg-gray-800 border border-gray-600 rounded px-2 py-1 text-xs text-white text-right"
                        />
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between p-4 border-t border-gray-700">
          <button
            onClick={handleReset}
            className="text-xs px-3 py-1.5 bg-gray-700 hover:bg-gray-600 rounded text-gray-300"
          >
            Reset to Defaults
          </button>
          <div className="flex items-center gap-2">
            {saved && <span className="text-xs text-green-400">Saved!</span>}
            <button
              onClick={handleSave}
              disabled={saving}
              className="text-xs px-4 py-1.5 bg-cyan-700 hover:bg-cyan-600 rounded text-white disabled:opacity-50"
            >
              {saving ? 'Saving...' : 'Save'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default SettingsPanel;
