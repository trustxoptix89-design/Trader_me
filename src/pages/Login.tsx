import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { trpc } from "@/providers/trpc";

export default function Login() {
  const [password, setPassword] = useState("");
  const navigate = useNavigate();
  const utils = trpc.useUtils();
  const login = trpc.auth.login.useMutation({
    onSuccess: async () => {
      await utils.invalidate();
      navigate("/");
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (password) login.mutate({ password });
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-4" dir="rtl">
      <Card className="w-full max-w-sm">
        <CardHeader className="text-center">
          <CardTitle>سرمایه — ورود مالک</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="owner-password">رمز عبور</Label>
              <Input
                id="owner-password"
                type="password"
                autoComplete="current-password"
                dir="ltr"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoFocus
              />
            </div>
            {login.error && <p role="alert" className="text-sm text-red-500">{login.error.message}</p>}
            <Button className="w-full" size="lg" type="submit" disabled={login.isPending || !password}>
              {login.isPending ? "در حال ورود…" : "ورود"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
