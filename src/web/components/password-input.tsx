import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type InputHTMLAttributes,
} from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { cn } from '../lib/utils';

export const PasswordInput = forwardRef<
  HTMLInputElement,
  InputHTMLAttributes<HTMLInputElement> & { revealLabel?: string }
>(({ className, disabled, revealLabel, ...props }, ref) => {
  const [visible, setVisible] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useImperativeHandle(ref, () => input.current!, []);
  const label = revealLabel ?? (props.name === 'password' ? 'password' : 'value');
  useEffect(() => {
    const hide = () => setVisible(false);
    const form = input.current?.form;
    window.addEventListener('blur', hide);
    document.addEventListener('visibilitychange', hide);
    form?.addEventListener('reset', hide);
    return () => {
      window.removeEventListener('blur', hide);
      document.removeEventListener('visibilitychange', hide);
      form?.removeEventListener('reset', hide);
    };
  }, []);
  useEffect(() => {
    if (disabled) setVisible(false);
  }, [disabled]);
  return (
    <span className="password-input">
      <input
        {...props}
        ref={input}
        className={cn('input', className)}
        type={visible ? 'text' : 'password'}
        disabled={disabled}
        data-secret-input
        data-analytics-private
      />
      <button
        type="button"
        className="button button-ghost button-icon password-input-toggle"
        disabled={disabled}
        aria-label={`${visible ? 'Hide' : 'Show'} ${label}`}
        aria-pressed={visible}
        onClick={(event) => {
          event.preventDefault();
          setVisible((current) => !current);
        }}
      >
        {visible ? <EyeOff size={18} aria-hidden="true" /> : <Eye size={18} aria-hidden="true" />}
      </button>
    </span>
  );
});
PasswordInput.displayName = 'PasswordInput';
